// M16.1 — At-Home Combine: standardized, measurable tests recorded live with
// Box Cam. This module is a MEASUREMENT LAYER over M16, not a second camera
// stack: every Combine Attempt binds a server-minted Box Cam session
// (ctx.boxMintSession) and is completed through the shared Box Cam completion
// path (ctx.boxCompleteSession), inheriting all Box Cam integrity. The
// Combine measurement is derived — server-side, from the session's own
// server-derived values — in the onSessionFinalized hook. Clients never
// supply a measured value, a Combine state or a provenance.
//
// The one honesty gate that everything rests on: a protocol's metric can only
// be Combine Verified if the ACTIVE observation provider genuinely supports
// every capability the protocol requires. Production web capture supports
// active_duration only, so only Box Control 60 is Combine Verified in
// production today; count/interval protocols report "measurement not yet
// supported on this device" and are exercised in the demo/test provider,
// always labelled simulated. Future athletic protocols need capabilities no
// provider has — not even the test one — so their sprint/jump/distance
// numbers are never fabricated anywhere.
import { isAdult, visibleToOrg } from '../domain.mjs';
import { latestDrill, PROVIDERS, providerFor } from './drills.mjs';
import {
  COMBINE_PROTOCOLS, combineProtocol, latestCombineProtocol, measurementSupported,
  measurementCapability, measureAttempt, formatCombineValue, personalBest,
  combineResultHash, comparisonMatrix, COMBINE_TERMINAL, COMBINE_STATE_COPY,
  liveCombineState,
} from './combineShared.mjs';
import { rateLimitedBody } from '../m181/rateLimit.mjs';

const PROD_PROVIDER_ID = 'web_client'; // the best honest production provider here

export function registerCombine(ctx) {
  const {
    db, playerRouter, guardianRouter, orgRouter, adminRouter, nextId,
    persistNow, notify, ledgerAppend, broadcast, findPlayer, isBlocked,
    moderateOrRefuse, vmetric, testProviderEnabled,
  } = ctx;

  db.combineAttempts ??= [];
  db.combineRequests ??= [];

  const orgCanSee = (org, p) => !!p && visibleToOrg(p, org) && !isBlocked(p.id, org.id);
  const guardianOwnsChild = (g, id) => g.childIds.includes(id);
  const ageOf = (p) => { try { return Math.floor((Date.now() - new Date(p.dob).getTime()) / (365.25 * 86_400_000)); } catch { return null; } };
  const prodProvider = PROVIDERS[PROD_PROVIDER_ID];

  // Rate limits (per §109 / §76): attempt creation and request creation.
  // M18.1: the shared limiter and its named policy (see m181/rateLimit.mjs).
  const limited = (action, keyPart) => !!ctx.rateLimit?.limited(action, keyPart);

  // ------------------------------------------------------------- views
  const protocolPublic = (p) => ({
    id: p.id, version: p.version, title: p.title, category: p.category,
    description: p.description, metricType: p.metricType, metricUnit: p.metricUnit,
    direction: p.direction, precision: p.precision, protocolWindowMs: p.protocolWindowMs,
    requiredCapabilities: p.requiredCapabilities,
    // Honest, device-aware capability: is this measurable on the production
    // provider here? The test/demo provider can simulate the rest.
    measurementCapability: measurementCapability(p, prodProvider.capabilities),
    demoSupported: testProviderEnabled && measurementSupported(p, PROVIDERS.local_test.capabilities),
    setupRequirements: p.setupRequirements, cameraRequirements: p.cameraRequirements,
    spaceRequirements: p.spaceRequirements, equipmentRequirements: p.equipmentRequirements,
    calibrationRequirements: p.calibrationRequirements,
    startRule: p.startRule, finishRule: p.finishRule, validAttemptRules: p.validAttemptRules,
    scoringMethod: p.scoringMethod, maxVerifiedPerWindow: p.maxVerifiedPerWindow,
    practiceAllowed: p.practiceAllowed, safetyNotes: p.safetyNotes, status: p.status,
    unsupportedNote: measurementCapability(p, prodProvider.capabilities) === 'not_configured'
      ? 'Combine measurement is not yet supported on this device. ScoutBox will not estimate or fabricate a result for this test.' : null,
  });

  function boundSession(a) { return db.boxSessions.find((s) => s.id === a.boxSessionId) ?? null; }

  // Effective (live) Combine state: a Combine Verified result whose bound Box
  // Cam session is later invalidated by Trust & Safety immediately stops
  // counting; a restore brings it back. Computed at read time so invalidation
  // is reflected everywhere without rewriting the stored attempt.
  // The rule itself lives in combineShared.mjs as `liveCombineState` so M21's
  // objective targets ask the same question and cannot get a different answer.
  const effectiveState = (a) => liveCombineState(a, boundSession(a));

  function verificationChecklist(a, proto) {
    return [
      { label: 'Standardized ScoutBox protocol', ok: true, detail: `${proto.title} v${proto.version}` },
      { label: 'Live Box Cam capture', ok: true },
      { label: 'Liveness passed', ok: true },
      { label: 'Required camera setup passed', ok: !a.calibrationResult || a.calibrationResult.passed },
      { label: 'Result calculated by ScoutBox', ok: true },
      { label: 'Detector supported this metric', ok: true },
      { label: 'Attempt integrity passed', ok: true },
    ];
  }

  const attemptView = (a, { includeIntegrity = false } = {}) => {
    const proto = combineProtocol(a.protocolId, a.protocolVersion) ?? latestCombineProtocol(a.protocolId);
    const st = effectiveState(a);
    const verified = st === 'combine_verified';
    return {
      id: a.id, playerId: a.playerId,
      protocolId: a.protocolId, protocolVersion: a.protocolVersion,
      protocolTitle: proto?.title ?? a.protocolId,
      metricType: a.metricType, metricUnit: a.metricUnit, direction: a.direction,
      mode: a.mode, captureContext: a.captureContext, requestId: a.requestId ?? null,
      attemptNumber: a.attemptNumber,
      measuredValue: a.measuredValue,
      display: proto ? formatCombineValue(proto, a.measuredValue) : `${a.measuredValue ?? '—'}`,
      unit: a.metricUnit,
      measurementState: a.measurementState, combineState: st,
      stateCopy: COMBINE_STATE_COPY[st] ?? null,
      reasons: a.reasons ?? [],
      provider: a.provider, providerVersion: a.providerVersion,
      simulated: !!PROVIDERS[a.provider]?.testOnly,
      calibration: a.calibrationResult ?? null,
      startedAt: a.startedAt ?? null, completedAt: a.completedAt ?? null, createdAt: a.createdAt,
      provenance: verified ? 'box_cam_observed' : null,
      provenanceLabel: verified ? 'Combine Verified' : null,
      verificationExplained: verified && proto ? verificationChecklist(a, proto) : null,
      ...(includeIntegrity ? { boxSessionId: a.boxSessionId, resultHash: a.resultHash ?? null, measurementAlgorithmVersion: a.measurementAlgorithmVersion } : {}),
    };
  };
  ctx.combineAttemptView = attemptView;

  const playerAttempts = (playerId) => db.combineAttempts.filter((a) => a.playerId === playerId);
  const verifiedAttempts = (playerId) => playerAttempts(playerId)
    .map((a) => ({ ...a, effectiveState: effectiveState(a) }))
    .filter((a) => a.effectiveState === 'combine_verified' && a.measuredValue != null);

  /** Best verified attempt per protocol@version for a player. */
  function bestsFor(playerId) {
    const byKey = new Map();
    for (const a of verifiedAttempts(playerId)) {
      const key = `${a.protocolId}@${a.protocolVersion}`;
      (byKey.get(key) ?? byKey.set(key, []).get(key)).push(a);
    }
    const out = new Map();
    for (const [key, list] of byKey) out.set(key, personalBest(list));
    return out;
  }

  // ---------------------------------------------------- projection (passport/club)
  // A recruitment-safe projection of a player's verified Combine results. Never
  // exposes raw video, DOB, private notes or integrity internals.
  function combineProjection(playerId) {
    const bests = bestsFor(playerId);
    const results = [...bests.values()].filter(Boolean).map((a) => {
      const proto = combineProtocol(a.protocolId, a.protocolVersion);
      return {
        protocolId: a.protocolId, protocolVersion: a.protocolVersion,
        protocolTitle: proto?.title ?? a.protocolId,
        metricUnit: a.metricUnit, measuredValue: a.measuredValue,
        display: proto ? formatCombineValue(proto, a.measuredValue) : `${a.measuredValue}`,
        combineVerified: true, capturedBy: 'box_cam', completedAt: a.completedAt,
      };
    }).sort((x, y) => (y.completedAt ?? 0) - (x.completedAt ?? 0));
    return {
      results,
      hasCombineVerifiedResults: results.length > 0,
      note: 'Combine Verified: measured from a standardized ScoutBox protocol during a live Box Cam session. Powered by Box Cam. Real numbers, not a talent score.',
    };
  }
  ctx.combineProjection = combineProjection;
  // Safe facts for future Recruitment Rooms / Watchlists (§26/§96) — factual
  // measurements only, never an athletic/talent score.
  ctx.combineFacts = (playerId) => {
    const proj = combineProjection(playerId);
    const map = {};
    for (const r of proj.results) map[`${r.protocolId}`] = r.measuredValue;
    return { hasCombineVerifiedResults: proj.hasCombineVerifiedResults, combineProtocolResults: map };
  };

  // The same standardized registry, readable by a club so a Club Combine (and
  // a Recruitment Room) SELECTS from it rather than hard-coding protocol ids.
  // Read-only definitions: no player data of any kind.
  orgRouter.get('/combine/protocols', (_req, res) => {
    res.json({
      protocols: COMBINE_PROTOCOLS.map(protocolPublic),
      note: 'Standardized protocols. A club selects from this registry and can never alter a protocol’s rules.',
    });
  });

  // ================================================================ PLAYER
  playerRouter.get('/combine/protocols', (_req, res) => {
    res.json({
      protocols: COMBINE_PROTOCOLS.map(protocolPublic),
      productionProvider: { id: prodProvider.id, status: prodProvider.status, label: prodProvider.label ?? prodProvider.status, capabilities: prodProvider.capabilities },
      testProviderEnabled,
      note: 'A Combine test can be Combine Verified only when the active detector genuinely supports its metric. Unsupported tests are labelled honestly and never estimated.',
    });
  });

  function myCombine(player) {
    const attempts = playerAttempts(player.id);
    const bests = bestsFor(player.id);
    const requests = db.combineRequests.filter((r) => r.playerId === player.id && r.state !== 'cancelled');
    return {
      verifiedResults: [...bests.values()].filter(Boolean).map((a) => attemptView(a)),
      personalBests: [...bests.values()].filter(Boolean).length,
      attempts: attempts.sort((a, b) => (b.createdAt) - (a.createdAt)).slice(0, 50).map((a) => attemptView(a)),
      activeRequests: requests.filter((r) => r.state !== 'completed').map((r) => requestView(r)),
      capabilityNote: 'Real numbers. Real evidence. From anywhere. Some tests are not yet measurable on this device — those are marked, never estimated.',
    };
  }
  playerRouter.get('/combine', (req, res) => res.json(myCombine(req.player)));
  guardianRouter.get('/children/:id/combine', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    res.json(myCombine(child));
  });

  playerRouter.get('/combine/card', (req, res) => res.json(combineCard(req.player)));
  function combineCard(player) {
    const bests = bestsFor(player.id);
    return {
      player: { id: player.id, name: player.name, age: ageOf(player), position: player.position ?? null },
      results: [...bests.values()].filter(Boolean).map((a) => {
        const proto = combineProtocol(a.protocolId, a.protocolVersion);
        return { protocolId: a.protocolId, protocolTitle: proto?.title ?? a.protocolId, display: formatCombineValue(proto, a.measuredValue), unit: a.metricUnit, combineVerified: true, protocolVersion: a.protocolVersion, completedAt: a.completedAt };
      }),
      capturedBy: 'box_cam', updatedAt: Date.now(),
      note: 'This card is a collection of standardized measurements captured with Box Cam. It is not an overall rating — clubs decide what matters.',
    };
  }

  playerRouter.get('/combine/attempts', (req, res) => {
    res.json({ items: playerAttempts(req.player.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map((a) => attemptView(a, { includeIntegrity: true })) });
  });
  playerRouter.get('/combine/attempts/:id', (req, res) => {
    const a = db.combineAttempts.find((x) => x.id === req.params.id && x.playerId === req.player.id);
    if (!a) return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
    res.json({ attempt: attemptView(a, { includeIntegrity: true }) });
  });

  // ------------------------------------------------------ create attempt
  playerRouter.post('/combine/attempts', (req, res) => {
    if (limited('combine_attempt', req.player.id)) return res.status(429).json(rateLimitedBody('combine_attempt'));
    const { protocolId, mode = 'verified', provider: providerId, captureContext = 'at_home', requestId } = req.body ?? {};
    const proto = latestCombineProtocol(String(protocolId ?? ''));
    if (!proto || proto.status !== 'active') return res.status(404).json({ error: 'PROTOCOL_UNKNOWN' });
    if (!['verified', 'practice'].includes(mode)) return res.status(400).json({ error: 'MODE_INVALID', allowed: ['verified', 'practice'] });
    if (mode === 'practice' && !proto.practiceAllowed) return res.status(400).json({ error: 'PRACTICE_NOT_ALLOWED' });
    if (!['at_home', 'club', 'event'].includes(captureContext)) return res.status(400).json({ error: 'CAPTURE_CONTEXT_INVALID' });
    if (proto.ageRestrictions === 'adult' && !isAdult(req.player)) return res.status(403).json({ error: 'ADULT_ONLY' });

    const provider = providerFor(String(providerId ?? PROD_PROVIDER_ID), { testProviderEnabled });
    if (!provider) return res.status(403).json({ error: 'PROVIDER_UNAVAILABLE' });
    if (provider.status === 'not_configured') return res.status(503).json({ error: 'PROVIDER_NOT_CONFIGURED', message: 'No production computer-vision provider is configured. This is stated honestly rather than simulated.' });

    // THE honesty gate. If the active provider cannot genuinely measure this
    // protocol's metric, there is no verified (or practice) measurement to be
    // had — we say so rather than estimate. (Under the gated test provider,
    // the count/duration/interval library is supported; future athletic
    // protocols need capabilities no provider has, so they stay unsupported
    // everywhere.)
    if (!measurementSupported(proto, provider.capabilities)) {
      vmetric('combine_measurement_provider_error');
      return res.status(422).json({
        error: 'MEASUREMENT_NOT_SUPPORTED',
        message: 'This Combine measurement is not yet supported on this device. ScoutBox does not estimate or fabricate a result.',
        missingCapabilities: proto.requiredCapabilities.filter((c) => !provider.capabilities.includes(c)),
      });
    }

    // Attempt limits apply to VERIFIED attempts only — practice is for
    // rehearsal and is generously (not punitively) capped.
    const since = Date.now() - proto.windowMs;
    if (mode === 'verified') {
      const recent = playerAttempts(req.player.id).filter((a) => a.protocolId === proto.id && a.mode === 'verified' && a.createdAt >= since).length;
      if (recent >= proto.maxVerifiedPerWindow) return res.status(429).json({ error: 'ATTEMPT_LIMIT_REACHED', maxVerifiedPerWindow: proto.maxVerifiedPerWindow, message: 'You have used your verified attempts for this Combine. Practice attempts remain available.' });
    } else {
      const recentPractice = playerAttempts(req.player.id).filter((a) => a.protocolId === proto.id && a.mode === 'practice' && a.createdAt >= Date.now() - 86_400_000).length;
      if (recentPractice >= 20) return res.status(429).json({ error: 'RATE_LIMITED' });
    }

    let request = null;
    if (requestId) {
      request = db.combineRequests.find((r) => r.id === requestId && r.playerId === req.player.id && r.state !== 'cancelled');
      if (!request) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
      if (!request.protocolIds.includes(proto.id)) return res.status(400).json({ error: 'PROTOCOL_NOT_IN_REQUEST' });
    }

    const drill = latestDrill(proto.drillId);
    if (!drill) return res.status(500).json({ error: 'PROTOCOL_DRILL_MISSING' });
    const attemptNumber = playerAttempts(req.player.id).filter((a) => a.protocolId === proto.id).length + 1;
    const session = ctx.boxMintSession({
      player: req.player, drill, target: proto.drillTarget, provider,
      meta: { combineAttemptId: null, captureContext },
    });
    const attempt = {
      id: nextId('catt'), playerId: req.player.id,
      protocolId: proto.id, protocolVersion: proto.version,
      boxSessionId: session.id, attemptNumber,
      mode, captureContext, requestId: request?.id ?? null,
      metricType: proto.metricType, metricUnit: proto.metricUnit, direction: proto.direction,
      measurementAlgorithmVersion: proto.measurementAlgorithmVersion,
      provider: provider.id, providerVersion: provider.version,
      calibrationResult: (proto.calibrationRequirements ?? []).length === 0
        ? { required: [], passed: true, checks: ['geometry_ready_check'], at: Date.now() } : null,
      measuredValue: null, measurementState: null, combineState: 'ready', reasons: [],
      startedAt: null, completedAt: null, resultHash: null, createdAt: Date.now(),
    };
    session.combineAttemptId = attempt.id;
    db.combineAttempts.push(attempt);
    vmetric('combine_attempt_started');
    if (mode === 'practice') vmetric('combine_practice_started');
    persistNow();
    res.status(201).json({
      attempt: attemptView(attempt, { includeIntegrity: true }),
      boxSession: ctx.boxSessionView(session),
      nonce: session.nonce, livenessChallenge: session.livenessChallenge,
      livenessNote: 'The liveness check establishes live-session presence. It is not identity verification.',
      expiresAt: session.expiresAt, protocol: protocolPublic(proto),
      readyCheck: { automated: ['camera_permission', 'camera_stream', 'device_orientation'], unableToCheckAutomatically: ['lighting', 'framing', 'space', 'single_participant'] },
      calibration: { required: proto.calibrationRequirements ?? [], note: (proto.calibrationRequirements ?? []).length ? 'This protocol needs a Box Marker for physical-scale calibration.' : 'No physical-scale calibration required — standardized geometry only.' },
    });
  });

  playerRouter.post('/combine/attempts/:id/calibrate', (req, res) => {
    const a = db.combineAttempts.find((x) => x.id === req.params.id && x.playerId === req.player.id);
    if (!a) return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
    if (COMBINE_TERMINAL.has(a.combineState)) return res.status(409).json({ error: 'ALREADY_FINALIZED' });
    const proto = combineProtocol(a.protocolId, a.protocolVersion);
    const required = proto?.calibrationRequirements ?? [];
    const checks = Array.isArray(req.body?.checks) ? req.body.checks.map(String) : [];
    // First-library protocols need standardized geometry only (passes when
    // the Ready Check geometry passes). Physical-scale calibration (Box
    // Marker) is required by future protocols, which are unsupported anyway.
    const passed = required.length === 0 ? true : required.every((r) => checks.includes(r));
    a.calibrationResult = { required, passed, checks, at: Date.now() };
    persistNow();
    res.json({ attempt: attemptView(a, { includeIntegrity: true }), calibrationPassed: passed });
  });

  // Complete: reuse the shared Box Cam completion path (finalize + hook).
  playerRouter.post('/combine/attempts/:id/complete', (req, res) => {
    const a = db.combineAttempts.find((x) => x.id === req.params.id && x.playerId === req.player.id);
    if (!a) return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
    if (COMBINE_TERMINAL.has(a.combineState)) return res.status(409).json({ error: 'ALREADY_FINALIZED', message: 'A completed Combine Attempt cannot be submitted again.' });
    const s = boundSession(a);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if ((req.body ?? {}).nonce !== s.nonce) return res.status(403).json({ error: 'NONCE_INVALID' });
    if (s.status !== 'recording') return res.status(409).json({ error: 'SESSION_NOT_RECORDING', status: s.status });
    a.startedAt = s.startedAt;
    ctx.boxCompleteSession(s, req.player); // -> onSessionFinalized -> applyCombineProgress
    res.json({ attempt: attemptView(a, { includeIntegrity: true }), boxSession: ctx.boxSessionView(s) });
  });

  playerRouter.post('/combine/attempts/:id/cancel', (req, res) => {
    const a = db.combineAttempts.find((x) => x.id === req.params.id && x.playerId === req.player.id);
    if (!a) return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
    if (COMBINE_TERMINAL.has(a.combineState)) return res.status(409).json({ error: 'ALREADY_FINALIZED' });
    a.combineState = 'cancelled'; a.measurementState = 'cancelled'; a.completedAt = Date.now();
    const s = boundSession(a);
    if (s && s.status === 'recording') { s.status = 'cancelled'; s.verificationState = 'cancelled'; }
    persistNow();
    res.json({ attempt: attemptView(a) });
  });

  // -------------------------------- measurement derivation (server-side hook)
  function applyCombineProgress(session, player) {
    if (!session.combineAttemptId) return;
    const a = db.combineAttempts.find((x) => x.id === session.combineAttemptId);
    if (!a || COMBINE_TERMINAL.has(a.combineState)) return;
    const proto = combineProtocol(a.protocolId, a.protocolVersion);
    const provider = PROVIDERS[session.provider];
    const calibrationPassed = a.calibrationResult ? a.calibrationResult.passed : (proto?.calibrationRequirements ?? []).length === 0;
    const r = measureAttempt({
      protocolDef: proto, session,
      calibrationPassed,
      providerCapabilities: provider?.capabilities ?? [],
      mode: a.mode,
    });
    a.measuredValue = r.measuredValue;
    a.measurementState = r.measurementState;
    a.combineState = r.combineState;
    a.reasons = r.reasons ?? [];
    a.completedAt = Date.now();
    a.resultHash = combineResultHash(a);
    vmetric('combine_attempt_completed');
    if (a.combineState === 'combine_verified') vmetric('combine_attempt_verified');
    else if (a.combineState === 'partially_measured') vmetric('combine_attempt_incomplete');
    ledgerAppend?.({ type: 'combine_attempt_completed', playerId: player.id, orgId: null, detail: { attemptId: a.id, protocol: `${a.protocolId}@${a.protocolVersion}`, state: a.combineState } });
    const label = proto?.title ?? a.protocolId;
    if (a.mode === 'verified' && a.combineState === 'combine_verified') {
      notify({ kind: 'player', id: player.id }, 'combine', `Combine Verified: ${label} — ${formatCombineValue(proto, a.measuredValue)} ${a.metricUnit}. Record it. Prove it.`, a.id);
      applyRequestProgress(player);
    } else if (a.mode === 'verified') {
      notify({ kind: 'player', id: player.id }, 'combine', `${label}: ${COMBINE_STATE_COPY[a.combineState] ?? 'recorded'}`, a.id);
    }
    broadcast('player_development_evidence_changed', { playerId: player.id });
    persistNow();
  }
  // Chain onto the existing hook so Box Training AND Combine both run.
  const prevHook = ctx.onSessionFinalized;
  ctx.onSessionFinalized = (session, player) => { prevHook?.(session, player); applyCombineProgress(session, player); };

  // ============================================================== REQUESTS
  const requestView = (r) => {
    const done = requiredDone(r);
    return {
      id: r.id, orgId: r.orgId, orgName: r.orgName, title: r.title,
      requestedBy: r.requestedBy, playerId: r.playerId,
      protocols: r.protocolIds.map((pid) => {
        const proto = latestCombineProtocol(pid);
        return { protocolId: pid, protocolTitle: proto?.title ?? pid, completed: done.has(pid) };
      }),
      deadline: r.deadline ?? null, instructions: r.instructions ?? null,
      state: requestState(r), createdAt: r.createdAt,
      completedCount: done.size, requiredCount: r.protocolIds.length,
      note: 'Completing a Club Combine means the standardized tests were completed and Combine Verified. It does not mean the club has selected, endorsed or rejected the player.',
    };
  };
  /** Which required protocols have a Combine-Verified attempt inside the
   *  request window (after it was created, before its deadline). */
  function requiredDone(r) {
    const done = new Set();
    const deadlineMs = r.deadline ? new Date(`${r.deadline}T23:59:59Z`).getTime() : Infinity;
    for (const a of verifiedAttempts(r.playerId)) {
      if (!r.protocolIds.includes(a.protocolId)) continue;
      const at = a.completedAt ?? 0;
      if (at >= r.createdAt && at <= deadlineMs) done.add(a.protocolId);
    }
    return done;
  }
  function requestState(r) {
    if (r.state === 'cancelled') return 'cancelled';
    return requiredDone(r).size >= r.protocolIds.length ? 'completed' : 'requested';
  }
  function applyRequestProgress(player) {
    for (const r of db.combineRequests.filter((x) => x.playerId === player.id && x.state === 'requested')) {
      if (requiredDone(r).size >= r.protocolIds.length) {
        r.state = 'completed'; r.completedAt = Date.now();
        vmetric('combine_request_completed');
        const org = db.orgs.find((o) => o.id === r.orgId);
        const lead = db.users.find((u) => u.id === r.requestedBy?.userId && !u.removedAt);
        if (lead) notify({ kind: 'org_user', id: lead.id }, 'combine', `${player.name} completed your Club Combine${r.title ? `: ${r.title}` : ''}.`, r.id);
        ledgerAppend?.({ type: 'combine_request_completed', playerId: player.id, orgId: r.orgId, orgName: org?.name, detail: { requestId: r.id } });
      }
    }
  }

  playerRouter.get('/combine/requests', (req, res) => {
    res.json({ items: db.combineRequests.filter((r) => r.playerId === req.player.id && r.state !== 'cancelled').map(requestView) });
  });
  guardianRouter.get('/children/:id/combine/requests', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    res.json({ items: db.combineRequests.filter((r) => r.playerId === req.params.id && r.state !== 'cancelled').map(requestView) });
  });

  // ================================================================== CLUB
  // The one creator for Club Combine requests. Extracted from the route so a
  // Recruitment Room (M17) can raise a request through exactly this code path
  // instead of growing a second copy of it. Callers do their own eligibility,
  // rate-limit and moderation checks first — this only creates.
  function createRequests({ org, orgUser, playerIds, protocolIds, title, deadline, instructions }) {
    const created = [];
    const skipped = [];
    for (const pid of playerIds) {
      const p = findPlayer(pid);
      // Standing gates hold exactly as elsewhere — a request never widens access.
      if (!p || !orgCanSee(org, p)) { skipped.push({ playerId: pid, reason: p ? 'NOT_VISIBLE' : 'PLAYER_NOT_FOUND' }); continue; }
      const r = {
        id: nextId('creq'), orgId: org.id, orgName: org.name,
        requestedBy: { userId: orgUser.id, name: orgUser.name, role: orgUser.role ?? null, at: Date.now() },
        playerId: p.id, title: String(title ?? '').slice(0, 120) || null,
        protocolIds, deadline: deadline ? String(deadline).slice(0, 10) : null,
        instructions: instructions ? String(instructions).slice(0, 300) : null,
        state: 'requested', createdAt: Date.now(), completedAt: null,
      };
      db.combineRequests.push(r);
      created.push(r);
      ledgerAppend?.({ type: 'combine_request_created', playerId: p.id, orgId: org.id, orgName: org.name, userId: orgUser.id, scoutName: orgUser.name, detail: { requestId: r.id, protocols: protocolIds } });
      const msg = `${org.name} requested an At-Home Combine${r.title ? `: ${r.title}` : ''} (${protocolIds.length} test${protocolIds.length > 1 ? 's' : ''}). Powered by Box Cam.`;
      if (!isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'combine', `${p.name}: ${msg}`, r.id);
      else notify({ kind: 'player', id: p.id }, 'combine', msg, r.id);
    }
    vmetric('combine_request_created', created.length);
    persistNow();
    return { created, skipped };
  }
  ctx.createCombineRequests = createRequests;
  ctx.combineRequestView = requestView;
  ctx.combineProtocolActive = (pid) => { const proto = latestCombineProtocol(pid); return !!proto && proto.status === 'active'; };

  // Create a Combine request / Club Combine: a verified, non-agency,
  // non-suspended org selects STANDARDIZED protocols (it cannot alter their
  // rules) for eligible players it can already see. No new access is granted.
  orgRouter.post('/combine/requests', (req, res) => {
    if (limited('room_combine_request', req.org.id)) return res.status(429).json(rateLimitedBody('room_combine_request'));
    if (req.org.type === 'agency') return res.status(403).json({ error: 'AGENCY_NOT_ELIGIBLE', message: 'Agencies cannot request At-Home Combines.' });
    if (req.org.suspended) return res.status(403).json({ error: 'ORG_SUSPENDED' });
    if (!req.org.verified) return res.status(403).json({ error: 'ORG_NOT_ELIGIBLE', message: 'Only a verified organisation can create a Club Combine.' });
    const { title, protocolIds, deadline, instructions } = req.body ?? {};
    const ids = Array.isArray(protocolIds) ? [...new Set(protocolIds.map(String))] : [];
    if (ids.length === 0) return res.status(400).json({ error: 'PROTOCOLS_REQUIRED' });
    for (const pid of ids) {
      const proto = latestCombineProtocol(pid);
      if (!proto || proto.status !== 'active') return res.status(404).json({ error: 'PROTOCOL_UNKNOWN', protocolId: pid });
    }
    const playerIds = Array.isArray(req.body?.playerIds) ? req.body.playerIds.map(String) : (req.body?.playerId ? [String(req.body.playerId)] : []);
    if (playerIds.length === 0) return res.status(400).json({ error: 'PLAYERS_REQUIRED' });
    if (instructions && !moderateOrRefuse(res, String(instructions), { kind: 'combine_request', orgId: req.org.id })) return;

    const { created, skipped } = createRequests({ org: req.org, orgUser: req.orgUser, playerIds, protocolIds: ids, title, deadline, instructions });
    if (created.length > 1 || playerIds.length > 1) vmetric('club_combine_created');
    res.status(created.length ? 201 : 409).json({ requests: created.map(requestView), skipped });
  });

  orgRouter.get('/combine/requests', (req, res) => {
    let mine = db.combineRequests.filter((r) => r.orgId === req.org.id);
    if (req.query.playerId) mine = mine.filter((r) => r.playerId === String(req.query.playerId));
    mine = mine.filter((r) => { const p = findPlayer(r.playerId); return p && orgCanSee(req.org, p); });
    res.json({ items: mine.map(requestView) });
  });

  orgRouter.post('/combine/requests/:id/cancel', (req, res) => {
    const r = db.combineRequests.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!r) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
    if (r.state === 'completed') return res.status(409).json({ error: 'ALREADY_COMPLETED' });
    r.state = 'cancelled';
    persistNow();
    res.json({ request: requestView(r) });
  });

  // Club sees a visible player's verified Combine results (recruitment-safe).
  // Access requires the standing gates AND either the player's recruitment
  // opt-in OR an active/completed request from THIS org (responding to a
  // request implies consent). Never raw video, DOB, notes or integrity.
  function orgMaySeeResults(org, p) {
    if (!orgCanSee(org, p)) return false;
    const prefs = ctx.boxPrefsFor(p.id);
    if (prefs.shareDevelopmentActivity === 'recruitment') return true;
    return db.combineRequests.some((r) => r.orgId === org.id && r.playerId === p.id && r.state !== 'cancelled');
  }
  // Shared with M17 so a Recruitment Room applies the identical consent rule
  // rather than inventing a laxer one. A room is not consent.
  ctx.combineOrgMaySeeResults = orgMaySeeResults;
  orgRouter.get('/combine/players/:id', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p || !orgCanSee(req.org, p)) return res.status(p ? 403 : 404).json({ error: p ? 'NOT_VISIBLE' : 'PLAYER_NOT_FOUND' });
    if (!orgMaySeeResults(req.org, p)) {
      return res.json({ playerId: p.id, results: [], shared: false, note: 'This player has not shared Combine results with your organisation. Request an At-Home Combine or ask them to share development activity.' });
    }
    const proj = combineProjection(p.id);
    res.json({ playerId: p.id, playerName: p.name, shared: true, ...proj });
  });

  orgRouter.get('/combine/compare', (req, res) => {
    const playerIds = String(req.query.playerIds ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30);
    const protoIds = String(req.query.protocols ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const protocols = (protoIds.length ? protoIds.map((pid) => latestCombineProtocol(pid)).filter(Boolean) : COMBINE_PROTOCOLS.filter((p) => measurementCapability(p, PROVIDERS.local_test.capabilities) === 'configured'));
    const players = [];
    const bestMap = new Map();
    for (const pid of playerIds) {
      const p = findPlayer(pid);
      if (!p || !orgMaySeeResults(req.org, p)) continue; // silently omit — no leak, no ranking
      players.push({ id: p.id, name: p.name });
      const bests = bestsFor(p.id);
      for (const proto of protocols) {
        const b = bests.get(`${proto.id}@${proto.version}`);
        if (b) bestMap.set(`${p.id}::${proto.id}@${proto.version}`, b);
      }
    }
    res.json(comparisonMatrix({ players, protocols, bestByPlayerProtocol: bestMap }));
  });

  // ================================================================== T&S
  // Trust & Safety reviews the BOUND Box Cam session (existing dispute/
  // invalidate/restore tooling). Combine attempts reflect that live: an
  // invalidated session drops Combine Verified everywhere. T&S never types a
  // replacement number.
  adminRouter.get('/combine/attempts/:id', (req, res) => {
    const a = db.combineAttempts.find((x) => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
    res.json({ attempt: attemptView(a, { includeIntegrity: true }), boxSession: ctx.boxSessionView(boundSession(a) ?? {}, { includeIntegrity: true }) });
  });

  return { attemptView, combineProjection, myCombine };
}
