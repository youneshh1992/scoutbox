// M16 — Box Cam sessions: server-owned identity, liveness, structured
// observation ingestion and server-derived results.
//
// Integrity model: the SERVER mints every Box Session (id + fresh nonce +
// liveness challenge + expiry). Clients stream aggregated observation
// events (never per-frame rows) bound to the session nonce with a strictly
// monotonic sequence and drift-bounded timestamps. The final result is
// derived exclusively from ACCEPTED observations and the server's own
// clock — client-supplied `verifiedActiveMs`, `verifiedReps`,
// `verificationState` or provenance fields are ignored wherever they
// appear. Box Cam Verified can only originate here: an uploaded video can
// never become `box_cam_observed`.
//
// S12b: a session is a row of repositories/boxCam.mjs. The nonce is stored only as its hash; the accepted
// observations are appended as rows per batch (`sessions.recordBatch`) and read once, by finalize.
import crypto from 'node:crypto';
import { isAdult } from '../../../domain.mjs';
import {
  verifiedActiveMs, dedupeReps, targetCompleted, detectionQuality,
  deriveVerification, resultHash, boxStreakWeeks, boxBests, boxCamDetail,
  mergeIntervals, normIntervals, sumIntervals, fmtMs, STATE_COPY, TERMINAL_STATES,
} from './shared.mjs';
import { drillByIdVersion, latestDrill, providerFor, LIVENESS_CHALLENGES, PROVIDERS } from './drills.mjs';
import { rateLimitedBody } from '../../platform/rateLimit.mjs';
import { hashNonce, nonceMatches, typeObservation, BOX_CAM_LIMITS } from '../../../repositories/boxCam.mjs';

const DRIFT_MS = 7_000;            // allowed client/server clock drift
const SESSION_TTL_MS = 2 * 3_600_000;
const MAX_EVENTS_PER_BATCH = 200;
const MAX_BATCHES_PER_SESSION = 500;
const MAX_STORED_INTERVALS = 2_000;
const EVENT_TYPES = new Set([
  'active_interval', 'presence_interval', 'ball_interval', 'rep',
  'set_completed', 'pause', 'resume', 'camera_interrupted', 'multi_person',
  'observation_gap',
]);

/** An accepted event as the observation row it becomes (`resume` closes the open pause). */
function observationOf(e) {
  switch (e.type) {
    case 'active_interval': return { kind: 'active', fromMs: e.fromMs ?? null, toMs: e.toMs ?? null, quality: e.quality ?? null };
    case 'presence_interval': return { kind: 'presence', fromMs: e.fromMs ?? null, toMs: e.toMs ?? null, quality: e.quality ?? null };
    case 'ball_interval': return { kind: 'ball', fromMs: e.fromMs ?? null, toMs: e.toMs ?? null };
    case 'rep': return { kind: 'rep', atMs: e.atMs ?? null, confidence: e.confidence ?? null };
    case 'set_completed': return { kind: 'set', atMs: e.atMs ?? null };
    case 'pause': return { kind: 'pause', fromMs: e.atMs ?? null, toMs: null };
    case 'resume': return { kind: 'resume', atMs: e.atMs ?? null };
    case 'camera_interrupted': case 'observation_gap': return { kind: 'interruption', fromMs: e.fromMs ?? null, toMs: e.toMs ?? null };
    case 'multi_person': return { kind: 'multi_person', fromMs: e.fromMs ?? null, toMs: e.toMs ?? null };
    default: return null;
  }
}

export function registerBoxCamSessions(ctx) {
  const {
    playerRouter, guardianRouter, adminRouter, nextId,
    notify, broadcast, moderateOrRefuse, vmetric, testProviderEnabled,
    boxCam, boxCamReads: reads, unit,
  } = ctx;

  const guardianOwnsChild = (g, id) => g.childIds.includes(id);

  // ----------------------------------------------------------- rate limits
  // M18.1: the shared limiter and its named policy (see domains/platform/rateLimit.mjs).
  const limited = (action, keyPart) => !!ctx.rateLimit?.limited(action, keyPart);

  const caps = (session) => {
    const drill = drillByIdVersion(session.drillId, session.drillVersion);
    const provider = PROVIDERS[session.provider];
    return (drill?.verificationCapabilities ?? []).filter((c) => (provider?.capabilities ?? []).includes(c));
  };

  const sessionView = (s, { includeIntegrity = false } = {}) => ({
    id: s.id, playerId: s.playerId, drillId: s.drillId, drillVersion: s.drillVersion,
    drillTitle: latestDrill(s.drillId)?.title ?? s.drillId,
    assignmentId: s.assignmentId ?? null, challengeEntryIds: s.challengeEntryId ? [s.challengeEntryId] : [],
    target: s.target, status: s.status,
    startedAt: s.startedAt ?? null, endedAt: s.endedAt ?? null,
    sessionDurationMs: s.sessionDurationMs ?? null,
    verifiedActiveMs: s.verifiedActiveMs ?? null,
    verifiedReps: s.verifiedReps ?? null,
    setsCompleted: s.setsCompleted ?? null,
    targetCompleted: s.targetCompleted ?? null,
    verificationState: s.verificationState ?? null,
    verificationReasons: s.verificationReasons ?? [],
    stateCopy: s.verificationState ? STATE_COPY[s.verificationState] ?? null : null,
    quality: s.quality ?? null,
    interruptions: s.interruptionsCount ?? 0,
    provider: s.provider, providerVersion: s.providerVersion,
    simulated: !!PROVIDERS[s.provider]?.testOnly, // never hide that a fixture drove this
    note: s.note ?? null,
    provenance: s.verificationState && ['verified', 'partially_verified'].includes(s.verificationState) ? 'box_cam_observed' : null,
    provenanceLabel: s.verificationState === 'verified' ? 'Box Cam Verified' : s.verificationState === 'partially_verified' ? 'Captured by Box Cam' : null,
    provenanceDetail: s.verificationState && ['verified', 'partially_verified'].includes(s.verificationState) ? boxCamDetail(s) : null,
    createdAt: s.createdAt,
    // The integrity facts are constants of every server-minted session (S12b: worked out, not stored).
    ...(includeIntegrity ? { resultHash: s.resultHash ?? null, integrity: s.id ? { minted: 'server', drift: DRIFT_MS } : null, lastSeq: s.lastSeq, batches: s.batches } : {}),
  });
  ctx.boxSessionView = sessionView;

  function findOwnSession(playerId, id) {
    const s = reads.sessions.byId(id);
    return s && s.playerId === playerId ? s : null;
  }

  /** A new server-minted session record and its plain nonce (returned once, never stored). */
  function newSession({ player, drill, target, provider, assignmentId = null, challengeEntryId = null, captureContext = null }) {
    const nonce = crypto.randomBytes(18).toString('base64url');
    const at = Date.now();
    return {
      nonce,
      record: {
        id: nextId('boxs'), playerId: player.id,
        drillId: drill.id, drillVersion: drill.version,
        assignmentId, challengeEntryId,
        target,
        nonceHash: hashNonce(nonce),
        livenessChallenge: LIVENESS_CHALLENGES[crypto.randomInt(LIVENESS_CHALLENGES.length)],
        provider: provider.id, providerVersion: provider.version,
        status: 'setup_required',
        createdAt: at, expiresAt: at + SESSION_TTL_MS,
        startedAt: null, endedAt: null, livenessPassedAt: null,
        lastSeq: 0, batches: 0, captureContext,
        sessionDurationMs: null, verifiedActiveMs: null, verifiedReps: null, setsCompleted: null, targetCompleted: null,
        quality: null, interruptionsCount: null, verificationState: null, verificationReasons: [], resultHash: null,
        finalizedAt: null, note: null, clipMediaId: null, previousVerificationState: null, invalidatedAt: null,
        integrityEvents: [], cvProviderSessionId: null,
      },
    };
  }

  // Server-owned session minting, shared with the At-Home Combine layer
  // (M16.1) so a Combine Attempt binds to a REAL Box Cam session and inherits
  // every integrity property here — the client never mints a session. Returns
  // `{ session, nonce }`; the caller hands the nonce back once. It joins the
  // caller's unit of work (the attempt is written with it).
  ctx.boxMintSession = ({ player, drill, target, provider, captureContext = null }) => {
    const { nonce, record } = newSession({ player, drill, target, provider, captureContext });
    const session = boxCam.sessions.create(record);
    vmetric('box_sessions_started');
    return { session, nonce };
  };

  // ------------------------------------------------------------- discovery
  playerRouter.get('/box-cam/drills', (_req, res) => {
    res.json({
      drills: ctx.drillList(),
      providers: Object.values(PROVIDERS)
        .filter((p) => !p.testOnly || testProviderEnabled)
        .map((p) => ({ id: p.id, status: p.status, label: p.label ?? p.status, capabilities: p.capabilities, testOnly: !!p.testOnly, note: p.note })),
      note: 'A drill only verifies what its detector and the active observation provider can genuinely observe.',
    });
  });

  // --------------------------------------------------------------- create
  playerRouter.post('/box-cam/sessions', (req, res) => {
    if (limited('box_session_create', req.player.id)) return res.status(429).json(rateLimitedBody('box_session_create'));
    const { drillId, target, provider: providerId, assignmentId, challengeEntryId } = req.body ?? {};
    const drill = latestDrill(String(drillId ?? ''));
    if (!drill) return res.status(404).json({ error: 'DRILL_UNKNOWN' });
    const provider = providerFor(String(providerId ?? 'web_client'), { testProviderEnabled });
    if (!provider) return res.status(403).json({ error: 'PROVIDER_UNAVAILABLE', message: 'The requested observation provider is not available in this environment.' });
    if (provider.status === 'not_configured') {
      return res.status(503).json({ error: 'PROVIDER_NOT_CONFIGURED', message: 'No production computer-vision provider is configured. This is stated honestly rather than simulated.' });
    }
    const t = target ?? {};
    if (!drill.targetTypes.includes(t.type)) return res.status(400).json({ error: 'TARGET_TYPE_UNSUPPORTED', allowed: drill.targetTypes });
    const bounds = { duration: [60_000, 2 * 3_600_000], repetitions: [1, 2_000], sets: [1, 20] };
    const [min, max] = bounds[t.type];
    // S12b: the value is a number as sent (a numeric string was accepted before).
    if (typeof t.value !== 'number' || !Number.isFinite(t.value) || t.value < min || t.value > max) return res.status(400).json({ error: 'TARGET_VALUE_INVALID', min, max });

    let assignment = null;
    if (assignmentId) {
      assignment = reads.assignments.byId(assignmentId);
      if (!assignment || assignment.playerId !== req.player.id) return res.status(404).json({ error: 'ASSIGNMENT_NOT_FOUND' });
      if (assignment.state === 'cancelled') return res.status(409).json({ error: 'ASSIGNMENT_CANCELLED', message: 'This assignment is no longer active.' });
      if (assignment.drillId !== drill.id) return res.status(400).json({ error: 'ASSIGNMENT_DRILL_MISMATCH' });
    }
    let entry = null;
    if (challengeEntryId) {
      entry = reads.entries.byId(challengeEntryId);
      if (!entry || entry.playerId !== req.player.id || entry.status !== 'active') return res.status(404).json({ error: 'CHALLENGE_ENTRY_NOT_FOUND' });
    }

    const { nonce, record } = newSession({ player: req.player, drill, target: { type: t.type, value: t.value }, provider, assignmentId: assignment?.id ?? null, challengeEntryId: entry?.id ?? null });
    const session = boxCam.sessions.create(record);
    vmetric('box_sessions_started');
    // The nonce and liveness challenge exist only in this response.
    res.status(201).json({
      session: sessionView(session),
      nonce,
      livenessChallenge: session.livenessChallenge,
      livenessNote: 'The liveness check establishes live-session presence. It is not identity verification.',
      expiresAt: session.expiresAt,
      drillSetup: drill.setup,
      readyCheck: {
        automated: ['camera_permission', 'camera_stream', 'device_orientation'],
        unableToCheckAutomatically: ['lighting', 'framing', 'space', 'single_participant'],
      },
    });
  });

  // ---------------------------------------------------------------- start
  playerRouter.post('/box-cam/sessions/:id/start', (req, res) => {
    const s = findOwnSession(req.player.id, req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (s.status !== 'setup_required') return res.status(409).json({ error: 'SESSION_NOT_STARTABLE', status: s.status });
    if (Date.now() > s.expiresAt) { boxCam.sessions.update(s.id, (d) => { d.status = 'cancelled'; }); return res.status(410).json({ error: 'SESSION_EXPIRED' }); }
    const { nonce, liveness } = req.body ?? {};
    if (!nonceMatches(s, nonce)) return res.status(403).json({ error: 'NONCE_INVALID' });
    if (!liveness) return res.status(403).json({ error: 'LIVENESS_REQUIRED', challenge: s.livenessChallenge });
    if (liveness !== s.livenessChallenge) return res.status(403).json({ error: 'LIVENESS_MISMATCH', message: 'Complete the liveness action the server asked for.' });
    const at = Date.now();
    const next = boxCam.sessions.update(s.id, (d) => { d.livenessPassedAt = at; d.startedAt = at; d.status = 'recording'; });
    res.json({ session: sessionView(next) });
  });

  // --------------------------------------------------------------- events
  playerRouter.post('/box-cam/sessions/:id/events', (req, res) => {
    const s = findOwnSession(req.player.id, req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (!nonceMatches(s, (req.body ?? {}).nonce)) return res.status(403).json({ error: 'NONCE_INVALID' });
    if (s.status !== 'recording') return res.status(409).json({ error: 'SESSION_NOT_RECORDING', status: s.status });
    if (Date.now() > s.expiresAt) return res.status(410).json({ error: 'SESSION_EXPIRED' });
    const batch = (req.body ?? {}).batch;
    if (!Array.isArray(batch) || batch.length === 0 || batch.length > MAX_EVENTS_PER_BATCH) {
      return res.status(400).json({ error: 'BATCH_INVALID', maxEvents: MAX_EVENTS_PER_BATCH });
    }
    if (s.batches >= MAX_BATCHES_PER_SESSION) return res.status(429).json({ error: 'RATE_LIMITED', message: 'Observation batch limit reached for this session.' });
    if (reads.sessions.storedIntervals(s.id) > MAX_STORED_INTERVALS) return res.status(429).json({ error: 'RATE_LIMITED', message: 'Observation storage limit reached.' });

    const elapsed = Date.now() - s.startedAt;
    // Real providers are bound to the server's clock (+ bounded drift): a
    // client cannot claim observation time that has not actually passed.
    // The TEST-ONLY fixture provider simulates the passage of time through
    // its observation stream (bounded by the session TTL) — such sessions
    // are always labelled simulated and can never exist in production.
    const simulated = !!PROVIDERS[s.provider]?.testOnly;
    const maxMs = simulated ? SESSION_TTL_MS : elapsed + DRIFT_MS;
    // Whole-batch sequencing: any non-monotonic/duplicate sequence rejects
    // the batch — replays and re-submissions never merge silently.
    let seq = s.lastSeq;
    const observations = [];
    for (const e of batch) {
      const n = Number(e?.seq);
      if (!Number.isSafeInteger(n) || n <= seq) return res.status(409).json({ error: 'SEQUENCE_INVALID', lastSeq: s.lastSeq });
      seq = n;
      if (!EVENT_TYPES.has(e.type)) return res.status(400).json({ error: 'EVENT_TYPE_UNKNOWN', type: String(e.type ?? '') });
      for (const k of ['atMs', 'fromMs', 'toMs']) {
        if (e[k] != null && (!Number.isFinite(Number(e[k])) || Number(e[k]) < 0 || Number(e[k]) > maxMs)) {
          return res.status(422).json({ error: 'TIMESTAMP_OUT_OF_RANGE', field: k, maxMs });
        }
      }
      // S12b: an event the engine cannot read is refused naming the field (it was dropped at finalize, or its
      // quality read as 'good', before).
      const o = observationOf(e);
      if (o.kind === 'resume') {
        if (typeof o.atMs !== 'number') return res.status(400).json({ error: 'EVENT_INVALID', seq: n, field: 'atMs', message: 'A resume needs atMs.' });
      } else {
        const typed = typeObservation(o, `event ${n}`);
        if (!typed.ok) return res.status(400).json({ error: 'EVENT_INVALID', seq: n, message: typed.reason });
      }
      observations.push(o);
    }
    if (reads.sessions.observationCount(s.id) + observations.length > BOX_CAM_LIMITS.maxObservations) {
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'Observation storage limit reached.' });
    }
    boxCam.sessions.recordBatch(s.id, { observations, lastSeq: seq });
    res.json({ accepted: batch.length, lastSeq: seq });
  });

  // ------------------------------------------------------------- finalize
  /** The finished session: every derived value worked out on `d` (a draft) from the accepted stream. */
  function finalize(d, obs, { cancelled = false } = {}) {
    const drill = drillByIdVersion(d.drillId, d.drillVersion);
    const provider = PROVIDERS[d.provider];
    const capabilities = caps(d);
    const now = Date.now();
    d.endedAt = now;
    // The server clock owns session duration — never a client field. For
    // the test-only fixture provider, simulated duration is the extent of
    // the accepted observation stream (deterministic, TTL-bounded).
    const simulated = !!provider?.testOnly;
    if (simulated) {
      let maxObserved = 0;
      for (const list of [obs.active, obs.presence, obs.ball, obs.interruptions, obs.multiPerson]) {
        for (const iv of list) maxObserved = Math.max(maxObserved, Number(iv.toMs) || 0);
      }
      for (const r of obs.reps) maxObserved = Math.max(maxObserved, Number(r.atMs) || 0);
      for (const x of obs.sets) maxObserved = Math.max(maxObserved, Number(x.atMs) || 0);
      for (const p of obs.pauses) maxObserved = Math.max(maxObserved, Number(p.toMs) || 0, Number(p.fromMs) || 0);
      d.sessionDurationMs = Math.min(maxObserved, SESSION_TTL_MS);
    } else {
      d.sessionDurationMs = d.startedAt ? Math.max(0, now - d.startedAt) : 0;
    }

    const dur = d.sessionDurationMs;
    const cuts = [
      ...obs.interruptions,
      ...obs.multiPerson, // multiple participants pause observation — no face recognition, no guessing
      ...obs.pauses.map((p) => ({ fromMs: p.fromMs, toMs: p.toMs ?? dur })),
    ];
    const ballRequired = (drill?.setup?.equipment ?? []).includes('ball') && capabilities.includes('ball_presence');
    d.verifiedActiveMs = verifiedActiveMs({
      activeIntervals: obs.active,
      pauses: [],
      interruptions: cuts,
      sessionDurationMs: dur,
      requiredIntervals: ballRequired ? obs.ball : null,
    });
    const presenceMs = sumIntervals(mergeIntervals(normIntervals(obs.presence, dur)));
    d.verifiedReps = capabilities.includes('rep_count')
      ? dedupeReps(obs.reps, { sessionDurationMs: dur, minGapMs: drill?.thresholds?.repMinGapMs ?? 250, minConfidence: drill?.thresholds?.repMinConfidence ?? 0.5 }).length
      : null;
    d.setsCompleted = capabilities.includes('interval_completion') ? obs.sets.length : null;
    d.targetCompleted = targetCompleted(d.target, { activeMs: d.verifiedActiveMs, reps: d.verifiedReps, setsCompleted: d.setsCompleted ?? 0 }, capabilities);
    d.quality = detectionQuality({ observedMs: Math.max(presenceMs, d.verifiedActiveMs), sessionDurationMs: dur });
    d.interruptionsCount = obs.interruptions.length + obs.multiPerson.length;

    const unsupportedTargetMetric = d.targetCompleted === null;
    const { state, reasons } = deriveVerification({
      cancelled,
      livenessPassed: !!d.livenessPassedAt,
      providerAvailable: provider ? provider.status !== 'not_configured' : false,
      activeMs: d.verifiedActiveMs,
      sessionDurationMs: dur,
      completed: d.targetCompleted,
      quality: d.quality,
      interruptionsCount: d.interruptionsCount,
      unsupportedTargetMetric,
    });
    d.verificationState = state;
    d.verificationReasons = reasons;
    if (drill?.repSupport === 'not_configured' && d.target.type === 'repetitions') {
      d.verificationReasons = [...new Set([...d.verificationReasons, 'REP_COUNT_NOT_CONFIGURED'])];
    }
    d.status = state;
    d.resultHash = resultHash(d);
    d.finalizedAt = now;
  }

  // Shared completion: finalize + notifications + the onSessionFinalized hook
  // (which drives assignment/challenge AND — from M16.1 — Combine
  // measurement). Both the Box Cam complete route and the At-Home Combine
  // complete route call this, so there is one code path. One unit of work:
  // the session, its assignment, entries, attempt, requests, ledger rows and
  // notifications commit together or not at all.
  function completeSession(sessionId, p) {
    const s = unit(() => {
      const obs = reads.sessions.observationsOf(sessionId);
      const done = boxCam.sessions.update(sessionId, (d) => finalize(d, obs));
      if (['verified', 'partially_verified'].includes(done.verificationState)) {
        notify({ kind: 'player', id: p.id }, 'box_cam', `Your work counts. ${fmtMs(done.verifiedActiveMs)} of ${latestDrill(done.drillId)?.title ?? done.drillId} was recorded in your training history.`, done.id);
        if (!isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'box_cam', `${p.name} completed a Box Session (${fmtMs(done.verifiedActiveMs)} Box Cam verified).`, done.id);
      } else {
        notify({ kind: 'player', id: p.id }, 'box_cam', STATE_COPY[done.verificationState] ?? 'Box Session recorded.', done.id);
      }
      ctx.onSessionFinalized?.(done, p);
      broadcast('player_development_evidence_changed', { playerId: p.id });
      return done;
    });
    vmetric('box_sessions_completed');
    if (s.verificationState === 'verified') vmetric('box_sessions_verified');
    if (s.verificationState === 'partially_verified') vmetric('box_sessions_partial');
    if (s.verificationState === 'unable_to_verify') vmetric('box_sessions_unverifiable');
    vmetric('box_session_active_seconds', Math.floor(s.verifiedActiveMs / 1000));
    return reads.sessions.byId(sessionId);
  }
  ctx.boxCompleteSession = completeSession;

  playerRouter.post('/box-cam/sessions/:id/complete', (req, res) => {
    const s = findOwnSession(req.player.id, req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (!nonceMatches(s, (req.body ?? {}).nonce)) return res.status(403).json({ error: 'NONCE_INVALID' });
    if (TERMINAL_STATES.has(s.status)) return res.status(409).json({ error: 'ALREADY_FINALIZED', message: 'A completed Box Session cannot be submitted again.' });
    if (s.status !== 'recording') return res.status(409).json({ error: 'SESSION_NOT_RECORDING', status: s.status });
    res.json({ session: sessionView(completeSession(s.id, req.player)) });
  });

  playerRouter.post('/box-cam/sessions/:id/cancel', (req, res) => {
    const s = findOwnSession(req.player.id, req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (TERMINAL_STATES.has(s.status)) return res.status(409).json({ error: 'ALREADY_FINALIZED' });
    const obs = s.status === 'recording' ? reads.sessions.observationsOf(s.id) : null;
    const next = boxCam.sessions.update(s.id, (d) => {
      if (obs) finalize(d, obs, { cancelled: true });
      else { d.status = 'cancelled'; d.verificationState = 'cancelled'; }
    });
    res.json({ session: sessionView(next) });
  });

  // ------------------------------------------------------ notes and reads
  playerRouter.post('/box-cam/sessions/:id/note', (req, res) => {
    const s = findOwnSession(req.player.id, req.params.id);
    if (!s || !TERMINAL_STATES.has(s.status)) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    const note = String(req.body?.note ?? '').slice(0, 300);
    if (!note.trim()) return res.status(400).json({ error: 'NOTE_REQUIRED' });
    if (!moderateOrRefuse(res, note, { kind: 'box_cam_note', playerId: req.player.id })) return;
    // A note is the player's words — provenance stays player_submitted_note
    // and never mixes with Box Cam observations.
    const next = boxCam.sessions.update(s.id, (d) => { d.note = note; });
    res.json({ session: sessionView(next) });
  });

  playerRouter.get('/box-cam/sessions', (req, res) => {
    res.json({ items: reads.sessions.finishedForPlayer(req.player.id, { limit: 50 }).map((s) => sessionView(s)) });
  });

  playerRouter.get('/box-cam/sessions/:id', (req, res) => {
    const s = findOwnSession(req.player.id, req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    res.json({ session: sessionView(s) });
  });

  guardianRouter.get('/children/:id/box-cam/sessions', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    res.json({ items: reads.sessions.finishedForPlayer(req.params.id, { limit: 50 }).map((s) => sessionView(s)) });
  });

  // --------------------------------------------------------- dashboards
  function dashboard(player) {
    const sessions = reads.sessions.finishedForPlayer(player.id).filter((s) => !['cancelled', 'invalidated'].includes(s.verificationState));
    const assignments = reads.assignments.forPlayer(player.id).filter((a) => a.state !== 'cancelled');
    return {
      streakWeeks: boxStreakWeeks(sessions),
      streakNote: 'A Box Streak is consistency against your planned training weeks. Rest days never break a streak.',
      bests: boxBests(sessions).map((b) => ({ ...b, bestActive: fmtMs(b.bestActiveMs) })),
      recent: sessions.slice(0, 10).map((s) => sessionView(s)),
      assignments: assignments.map(ctx.boxAssignmentView ?? ((a) => a)),
    };
  }
  playerRouter.get('/box-cam/dashboard', (req, res) => res.json(dashboard(req.player)));
  guardianRouter.get('/children/:id/box-cam/dashboard', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const child = ctx.findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    res.json(dashboard(child));
  });

  // ------------------------------------------------------------- clips
  // Optional Box Clip: reuses the EXISTING media pipeline (the client
  // uploads through /player/media as usual, with normal media provenance)
  // and then tags that media item as Box Cam captured. Raw session video is
  // never uploaded or retained by Box Cam itself — retainRawVideo=false is
  // structural: no route accepts it.
  playerRouter.post('/box-cam/sessions/:id/clip', (req, res) => {
    const s = findOwnSession(req.player.id, req.params.id);
    if (!s || !TERMINAL_STATES.has(s.status)) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    const prefs = ctx.boxPrefsFor(req.player.id);
    if (!isAdult(req.player) && !prefs.retainClips) {
      return res.status(403).json({ error: 'GUARDIAN_CONTROLLED', message: 'Your parent/guardian controls whether Box Clips from home training are kept.' });
    }
    const media = (req.player.media ?? []).find((m) => m.id === req.body?.mediaId);
    if (!media) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
    // ONE unit of work: the media row's Box Cam provenance, the session's clip
    // reference and the ledger row commit together.
    const next = unit(() => {
      ctx.players.patchItem(req.player.id, 'media', { id: media.id }, { capturedBy: 'box_cam', boxSessionId: s.id });
      const row = boxCam.sessions.update(s.id, (d) => { d.clipMediaId = media.id; });
      ctx.ledgerAppend?.({ type: 'box_clip_saved', playerId: req.player.id, orgId: null, detail: { sessionId: s.id, mediaId: media.id } });
      return row;
    });
    res.json({ session: sessionView(next), note: 'Clip kept with your media. Saving a clip never makes it public — its visibility follows your existing media privacy.' });
  });

  // -------------------------------------------------------------- T&S read
  adminRouter.get('/box-cam/sessions/:id', (req, res) => {
    const s = reads.sessions.byId(req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    res.json({ session: sessionView(s, { includeIntegrity: true }) });
  });

  return { sessionView, dashboard };
}
