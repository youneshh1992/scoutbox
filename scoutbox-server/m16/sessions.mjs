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
import crypto from 'node:crypto';
import { isAdult } from '../domain.mjs';
import {
  verifiedActiveMs, dedupeReps, targetCompleted, detectionQuality,
  deriveVerification, resultHash, boxStreakWeeks, boxBests, boxCamDetail,
  mergeIntervals, normIntervals, sumIntervals, fmtMs, STATE_COPY, TERMINAL_STATES,
} from './shared.mjs';
import { drillByIdVersion, latestDrill, providerFor, LIVENESS_CHALLENGES, PROVIDERS } from './drills.mjs';
import { rateLimitedBody } from '../m181/rateLimit.mjs';

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

export function registerBoxCamSessions(ctx) {
  const {
    db, playerRouter, guardianRouter, adminRouter, nextId, persistNow,
    notify, broadcast, findPlayer, moderateOrRefuse, vmetric, testProviderEnabled,
  } = ctx;

  const guardianOwnsChild = (g, id) => g.childIds.includes(id);

  // ----------------------------------------------------------- rate limits
  // M18.1: the shared limiter and its named policy (see m181/rateLimit.mjs).
  const limited = (action, keyPart) => !!ctx.rateLimit?.limited(action, keyPart);

  const caps = (session) => {
    const drill = drillByIdVersion(session.drillId, session.drillVersion);
    const provider = PROVIDERS[session.provider];
    return (drill?.verificationCapabilities ?? []).filter((c) => (provider?.capabilities ?? []).includes(c));
  };

  const sessionView = (s, { includeIntegrity = false } = {}) => ({
    id: s.id, playerId: s.playerId, drillId: s.drillId, drillVersion: s.drillVersion,
    drillTitle: latestDrill(s.drillId)?.title ?? s.drillId,
    assignmentId: s.assignmentId ?? null, challengeEntryIds: s.challengeEntryIds ?? [],
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
    ...(includeIntegrity ? { resultHash: s.resultHash ?? null, integrity: s.integrity ?? null, lastSeq: s.lastSeq, batches: s.batches } : {}),
  });
  ctx.boxSessionView = sessionView;

  function findOwnSession(playerId, id) {
    return db.boxSessions.find((s) => s.id === id && s.playerId === playerId) ?? null;
  }

  // Server-owned session minting, shared with the At-Home Combine layer
  // (M16.1) so a Combine Attempt binds to a REAL Box Cam session and inherits
  // every integrity property here — the client never mints a session. `meta`
  // carries the combine binding (combineAttemptId, captureContext); it can
  // never carry verified metrics.
  ctx.boxMintSession = ({ player, drill, target, provider, meta = {} }) => {
    const session = {
      id: nextId('boxs'), playerId: player.id,
      drillId: drill.id, drillVersion: drill.version,
      assignmentId: null, challengeEntryIds: [],
      target,
      nonce: crypto.randomBytes(18).toString('base64url'),
      livenessChallenge: LIVENESS_CHALLENGES[crypto.randomInt(LIVENESS_CHALLENGES.length)],
      provider: provider.id, providerVersion: provider.version,
      status: 'setup_required',
      createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS,
      startedAt: null, endedAt: null, livenessPassedAt: null,
      lastSeq: 0, batches: 0,
      obs: { active: [], presence: [], ball: [], reps: [], sets: [], pauses: [], interruptions: [], multiPerson: [] },
      captureMode: 'live',
      integrity: { minted: 'server', drift: DRIFT_MS },
      ...meta,
    };
    db.boxSessions.push(session);
    vmetric('box_sessions_started');
    persistNow();
    return session;
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
    const value = Number(t.value);
    const bounds = { duration: [60_000, 2 * 3_600_000], repetitions: [1, 2_000], sets: [1, 20], combined: [1, 20] };
    const [min, max] = bounds[t.type];
    if (!Number.isFinite(value) || value < min || value > max) return res.status(400).json({ error: 'TARGET_VALUE_INVALID', min, max });

    let assignment = null;
    if (assignmentId) {
      assignment = db.boxAssignments.find((a) => a.id === assignmentId && a.playerId === req.player.id) ?? null;
      if (!assignment) return res.status(404).json({ error: 'ASSIGNMENT_NOT_FOUND' });
      if (['cancelled', 'superseded'].includes(assignment.state)) return res.status(409).json({ error: 'ASSIGNMENT_CANCELLED', message: 'This assignment is no longer active.' });
      if (assignment.drillId !== drill.id) return res.status(400).json({ error: 'ASSIGNMENT_DRILL_MISMATCH' });
    }
    const challengeEntryIds = [];
    if (challengeEntryId) {
      const entry = db.boxChallengeEntries.find((e) => e.id === challengeEntryId && e.playerId === req.player.id && e.status === 'active');
      if (!entry) return res.status(404).json({ error: 'CHALLENGE_ENTRY_NOT_FOUND' });
      challengeEntryIds.push(entry.id);
    }

    const session = {
      id: nextId('boxs'), playerId: req.player.id,
      drillId: drill.id, drillVersion: drill.version,
      assignmentId: assignment?.id ?? null, challengeEntryIds,
      target: t.type === 'combined'
        ? { type: 'combined', sets: Number(t.sets) || 0, repsPerSet: Number(t.repsPerSet) || 0, value }
        : { type: t.type, value },
      nonce: crypto.randomBytes(18).toString('base64url'),
      livenessChallenge: LIVENESS_CHALLENGES[crypto.randomInt(LIVENESS_CHALLENGES.length)],
      provider: provider.id, providerVersion: provider.version,
      status: 'setup_required',
      createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS,
      startedAt: null, endedAt: null, livenessPassedAt: null,
      lastSeq: 0, batches: 0,
      obs: { active: [], presence: [], ball: [], reps: [], sets: [], pauses: [], interruptions: [], multiPerson: [] },
      captureMode: 'live',
      integrity: { minted: 'server', drift: DRIFT_MS },
    };
    db.boxSessions.push(session);
    vmetric('box_sessions_started');
    persistNow();
    // The nonce and liveness challenge exist only in this response.
    res.status(201).json({
      session: sessionView(session),
      nonce: session.nonce,
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
    if (Date.now() > s.expiresAt) { s.status = 'cancelled'; persistNow(); return res.status(410).json({ error: 'SESSION_EXPIRED' }); }
    const { nonce, liveness } = req.body ?? {};
    if (nonce !== s.nonce) return res.status(403).json({ error: 'NONCE_INVALID' });
    if (!liveness) return res.status(403).json({ error: 'LIVENESS_REQUIRED', challenge: s.livenessChallenge });
    if (liveness !== s.livenessChallenge) return res.status(403).json({ error: 'LIVENESS_MISMATCH', message: 'Complete the liveness action the server asked for.' });
    s.livenessPassedAt = Date.now();
    s.startedAt = Date.now();
    s.status = 'recording';
    persistNow();
    res.json({ session: sessionView(s) });
  });

  // --------------------------------------------------------------- events
  playerRouter.post('/box-cam/sessions/:id/events', (req, res) => {
    const s = findOwnSession(req.player.id, req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if ((req.body ?? {}).nonce !== s.nonce) return res.status(403).json({ error: 'NONCE_INVALID' });
    if (s.status !== 'recording') return res.status(409).json({ error: 'SESSION_NOT_RECORDING', status: s.status });
    if (Date.now() > s.expiresAt) return res.status(410).json({ error: 'SESSION_EXPIRED' });
    const batch = (req.body ?? {}).batch;
    if (!Array.isArray(batch) || batch.length === 0 || batch.length > MAX_EVENTS_PER_BATCH) {
      return res.status(400).json({ error: 'BATCH_INVALID', maxEvents: MAX_EVENTS_PER_BATCH });
    }
    if (s.batches >= MAX_BATCHES_PER_SESSION) return res.status(429).json({ error: 'RATE_LIMITED', message: 'Observation batch limit reached for this session.' });
    const stored = s.obs.active.length + s.obs.presence.length + s.obs.ball.length + s.obs.reps.length;
    if (stored > MAX_STORED_INTERVALS) return res.status(429).json({ error: 'RATE_LIMITED', message: 'Observation storage limit reached.' });

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
    for (const e of batch) {
      const n = Number(e.seq);
      if (!Number.isInteger(n) || n <= seq) return res.status(409).json({ error: 'SEQUENCE_INVALID', lastSeq: s.lastSeq });
      seq = n;
      if (!EVENT_TYPES.has(e.type)) return res.status(400).json({ error: 'EVENT_TYPE_UNKNOWN', type: String(e.type ?? '') });
      for (const k of ['atMs', 'fromMs', 'toMs']) {
        if (e[k] != null && (!Number.isFinite(Number(e[k])) || Number(e[k]) < 0 || Number(e[k]) > maxMs)) {
          return res.status(422).json({ error: 'TIMESTAMP_OUT_OF_RANGE', field: k, maxMs });
        }
      }
    }
    for (const e of batch) {
      switch (e.type) {
        case 'active_interval': s.obs.active.push({ fromMs: e.fromMs, toMs: e.toMs, quality: e.quality }); break;
        case 'presence_interval': s.obs.presence.push({ fromMs: e.fromMs, toMs: e.toMs, quality: e.quality }); break;
        case 'ball_interval': s.obs.ball.push({ fromMs: e.fromMs, toMs: e.toMs }); break;
        case 'rep': s.obs.reps.push({ atMs: e.atMs, confidence: e.confidence }); break;
        case 'set_completed': s.obs.sets.push({ atMs: e.atMs }); break;
        case 'pause': s.obs.pauses.push({ fromMs: e.atMs, toMs: null }); break;
        case 'resume': {
          const open = s.obs.pauses.find((p) => p.toMs === null);
          if (open) open.toMs = e.atMs;
          break;
        }
        case 'camera_interrupted': s.obs.interruptions.push({ fromMs: e.fromMs, toMs: e.toMs }); break;
        case 'observation_gap': s.obs.interruptions.push({ fromMs: e.fromMs, toMs: e.toMs }); break;
        case 'multi_person': s.obs.multiPerson.push({ fromMs: e.fromMs, toMs: e.toMs }); break;
      }
    }
    s.lastSeq = seq;
    s.batches += 1;
    persistNow();
    res.json({ accepted: batch.length, lastSeq: s.lastSeq });
  });

  // ------------------------------------------------------------- finalize
  function finalize(s, { cancelled = false } = {}) {
    const drill = drillByIdVersion(s.drillId, s.drillVersion);
    const provider = PROVIDERS[s.provider];
    const capabilities = caps(s);
    const now = Date.now();
    s.endedAt = now;
    // The server clock owns session duration — never a client field. For
    // the test-only fixture provider, simulated duration is the extent of
    // the accepted observation stream (deterministic, TTL-bounded).
    const simulated = !!provider?.testOnly;
    if (simulated) {
      let maxObserved = 0;
      for (const list of [s.obs.active, s.obs.presence, s.obs.ball, s.obs.interruptions, s.obs.multiPerson]) {
        for (const iv of list) maxObserved = Math.max(maxObserved, Number(iv.toMs) || 0);
      }
      for (const r of s.obs.reps) maxObserved = Math.max(maxObserved, Number(r.atMs) || 0);
      for (const x of s.obs.sets) maxObserved = Math.max(maxObserved, Number(x.atMs) || 0);
      for (const p of s.obs.pauses) maxObserved = Math.max(maxObserved, Number(p.toMs) || 0, Number(p.fromMs) || 0);
      s.sessionDurationMs = Math.min(maxObserved, SESSION_TTL_MS);
    } else {
      s.sessionDurationMs = s.startedAt ? Math.max(0, now - s.startedAt) : 0;
    }

    const dur = s.sessionDurationMs;
    const cuts = [
      ...s.obs.interruptions,
      ...s.obs.multiPerson, // multiple participants pause observation — no face recognition, no guessing
      ...s.obs.pauses.map((p) => ({ fromMs: p.fromMs, toMs: p.toMs ?? dur })),
    ];
    const ballRequired = (drill?.setup?.equipment ?? []).includes('ball') && capabilities.includes('ball_presence');
    s.verifiedActiveMs = verifiedActiveMs({
      activeIntervals: s.obs.active,
      pauses: [],
      interruptions: cuts,
      sessionDurationMs: dur,
      requiredIntervals: ballRequired ? s.obs.ball : null,
    });
    const presenceMs = sumIntervals(mergeIntervals(normIntervals(s.obs.presence, dur)));
    s.verifiedReps = capabilities.includes('rep_count')
      ? dedupeReps(s.obs.reps, { sessionDurationMs: dur, minGapMs: drill?.thresholds?.repMinGapMs ?? 250, minConfidence: drill?.thresholds?.repMinConfidence ?? 0.5 }).length
      : null;
    s.setsCompleted = capabilities.includes('interval_completion') ? s.obs.sets.length : null;
    s.targetCompleted = targetCompleted(s.target, { activeMs: s.verifiedActiveMs, reps: s.verifiedReps, setsCompleted: s.setsCompleted ?? 0 }, capabilities);
    s.quality = detectionQuality({ observedMs: Math.max(presenceMs, s.verifiedActiveMs), sessionDurationMs: dur });
    s.interruptionsCount = s.obs.interruptions.length + s.obs.multiPerson.length;

    const unsupportedTargetMetric = s.targetCompleted === null;
    const { state, reasons } = deriveVerification({
      cancelled,
      livenessPassed: !!s.livenessPassedAt,
      providerAvailable: provider ? provider.status !== 'not_configured' : false,
      activeMs: s.verifiedActiveMs,
      sessionDurationMs: dur,
      completed: s.targetCompleted,
      quality: s.quality,
      interruptionsCount: s.interruptionsCount,
      unsupportedTargetMetric,
    });
    s.verificationState = state;
    s.verificationReasons = reasons;
    if (drill?.repSupport === 'not_configured' && s.target.type === 'repetitions') {
      s.verificationReasons = [...new Set([...s.verificationReasons, 'REP_COUNT_NOT_CONFIGURED'])];
    }
    s.status = state;
    s.resultHash = resultHash(s);
    s.finalizedAt = now;
  }

  // Shared completion: finalize + metrics + notifications + the
  // onSessionFinalized hook (which drives assignment/challenge AND — from
  // M16.1 — Combine measurement). Both the Box Cam complete route and the
  // At-Home Combine complete route call this, so there is one code path.
  function completeSession(s, p) {
    s.status = 'processing';
    finalize(s);
    vmetric('box_sessions_completed');
    if (s.verificationState === 'verified') vmetric('box_sessions_verified');
    if (s.verificationState === 'partially_verified') vmetric('box_sessions_partial');
    if (s.verificationState === 'unable_to_verify') vmetric('box_sessions_unverifiable');
    vmetric('box_session_active_seconds', Math.floor(s.verifiedActiveMs / 1000));
    if (['verified', 'partially_verified'].includes(s.verificationState)) {
      notify({ kind: 'player', id: p.id }, 'box_cam', `Your work counts. ${fmtMs(s.verifiedActiveMs)} of ${latestDrill(s.drillId)?.title ?? s.drillId} was recorded in your training history.`, s.id);
      if (!isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'box_cam', `${p.name} completed a Box Session (${fmtMs(s.verifiedActiveMs)} Box Cam verified).`, s.id);
    } else {
      notify({ kind: 'player', id: p.id }, 'box_cam', STATE_COPY[s.verificationState] ?? 'Box Session recorded.', s.id);
    }
    ctx.onSessionFinalized?.(s, p);
    broadcast('player_development_evidence_changed', { playerId: p.id });
    persistNow();
    return s;
  }
  ctx.boxCompleteSession = completeSession;

  playerRouter.post('/box-cam/sessions/:id/complete', (req, res) => {
    const s = findOwnSession(req.player.id, req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if ((req.body ?? {}).nonce !== s.nonce) return res.status(403).json({ error: 'NONCE_INVALID' });
    if (TERMINAL_STATES.has(s.status)) return res.status(409).json({ error: 'ALREADY_FINALIZED', message: 'A completed Box Session cannot be submitted again.' });
    if (s.status !== 'recording') return res.status(409).json({ error: 'SESSION_NOT_RECORDING', status: s.status });
    completeSession(s, req.player);
    res.json({ session: sessionView(s) });
  });

  playerRouter.post('/box-cam/sessions/:id/cancel', (req, res) => {
    const s = findOwnSession(req.player.id, req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (TERMINAL_STATES.has(s.status)) return res.status(409).json({ error: 'ALREADY_FINALIZED' });
    if (s.status === 'recording') finalize(s, { cancelled: true });
    else { s.status = 'cancelled'; s.verificationState = 'cancelled'; }
    persistNow();
    res.json({ session: sessionView(s) });
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
    s.note = note;
    s.noteProvenance = 'player_submitted_note';
    persistNow();
    res.json({ session: sessionView(s) });
  });

  playerRouter.get('/box-cam/sessions', (req, res) => {
    const items = db.boxSessions
      .filter((s) => s.playerId === req.player.id && TERMINAL_STATES.has(s.status))
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, 50)
      .map((s) => sessionView(s));
    res.json({ items });
  });

  playerRouter.get('/box-cam/sessions/:id', (req, res) => {
    const s = findOwnSession(req.player.id, req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    res.json({ session: sessionView(s) });
  });

  guardianRouter.get('/children/:id/box-cam/sessions', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const items = db.boxSessions
      .filter((s) => s.playerId === req.params.id && TERMINAL_STATES.has(s.status))
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, 50)
      .map((s) => sessionView(s));
    res.json({ items });
  });

  // --------------------------------------------------------- dashboards
  function dashboard(player) {
    const sessions = db.boxSessions.filter((s) => s.playerId === player.id && TERMINAL_STATES.has(s.status) && !['cancelled', 'invalidated'].includes(s.verificationState));
    const assignments = db.boxAssignments.filter((a) => a.playerId === player.id && !['cancelled', 'superseded'].includes(a.state));
    return {
      streakWeeks: boxStreakWeeks(sessions),
      streakNote: 'A Box Streak is consistency against your planned training weeks. Rest days never break a streak.',
      bests: boxBests(sessions).map((b) => ({ ...b, bestActive: fmtMs(b.bestActiveMs) })),
      recent: sessions.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 10).map((s) => sessionView(s)),
      assignments: assignments.map(ctx.boxAssignmentView ?? ((a) => a)),
    };
  }
  playerRouter.get('/box-cam/dashboard', (req, res) => res.json(dashboard(req.player)));
  guardianRouter.get('/children/:id/box-cam/dashboard', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const child = findPlayer(req.params.id);
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
    media.capturedBy = 'box_cam';
    media.boxSessionId = s.id;
    s.clipMediaId = media.id;
    ctx.ledgerAppend?.({ type: 'box_clip_saved', playerId: req.player.id, orgId: null, detail: { sessionId: s.id, mediaId: media.id } });
    persistNow();
    res.json({ session: sessionView(s), note: 'Clip kept with your media. Saving a clip never makes it public — its visibility follows your existing media privacy.' });
  });

  // -------------------------------------------------------------- T&S read
  adminRouter.get('/box-cam/sessions/:id', (req, res) => {
    const s = db.boxSessions.find((x) => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    res.json({ session: sessionView(s, { includeIntegrity: true }) });
  });

  return { sessionView, dashboard };
}
