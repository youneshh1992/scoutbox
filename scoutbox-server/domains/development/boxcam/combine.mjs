// At-Home Combine: standardized, measurable tests recorded live with
// Box Cam. This module is a MEASUREMENT LAYER over Box Cam, not a second camera
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
//
// Requests and attempts are rows of repositories/boxCam.mjs, written by explicit operations (an attempt with its
// minted session in one unit of work; the measurement inside the session's completion unit), read through
// `boxCamReads`.
import { isAdult, visibleToOrg } from '../../../domain.mjs';
import { ageOrNull, endOfDayExclusive, parseStrictDateOnly, isAbsent } from '../../../temporal.mjs';
import { latestDrill, PROVIDERS, providerFor } from './drills.mjs';
import {
  COMBINE_PROTOCOLS, combineProtocol, latestCombineProtocol, measurementSupported,
  measurementCapability, measureAttempt, formatCombineValue, personalBest,
  combineResultHash, comparisonMatrix, COMBINE_TERMINAL, COMBINE_STATE_COPY,
  liveCombineState,
} from './combineShared.mjs';
import { rateLimitedBody, limitCheck } from '../../platform/rateLimit.mjs';
import { combineCapabilities } from './cv/eligibility.mjs';
import { CV_PROVIDER_ID } from './cv/policy.mjs';
import { nonceMatches } from '../../../repositories/boxCam.mjs';
import { readPage, pageOf, sendPageError } from '../../platform/paging.mjs';
import { pageNewestFirst } from './shared.mjs';

const PROD_PROVIDER_ID = 'web_client'; // the best honest production provider here

export function registerCombine(ctx) {
  const {
    byId, playerRouter, guardianRouter, orgRouter, adminRouter, nextId,
    notify, ledgerAppend, broadcast, findPlayer, isBlocked,
    moderateOrRefuse, vmetric, testProviderEnabled, boxCam, boxCamReads: reads, unit,
  } = ctx;

  const orgCanSee = (org, p) => !!p && visibleToOrg(p, org) && !isBlocked(p.id, org.id);
  const guardianOwnsChild = (g, id) => g.childIds.includes(id);
  // THE age rule: a missing dob is a null age, by rule.
  const ageOf = (p) => ageOrNull(p?.dob, Date.now());
  const prodProvider = PROVIDERS[PROD_PROVIDER_ID];

  // ------------------------------------------------------ the Combine gate
  //
  // THE distinction the gate turns on. A provider's `capabilities` list is what it
  // can OBSERVE. That is the right input for Box Cam, and the wrong input for
  // Combine, because a Combine measurement is a standardised, comparable
  // NUMBER and comparability is a claim about the real world.
  //
  // `production_cv` genuinely observes touches, so handing its observation
  // list to `measurementSupported()` would mint Combine Verified off synthetic
  // evidence alone. Instead its Combine list is derived per protocol from the
  // versioned real-world validation record, and is currently empty for every
  // protocol. No argument to this function can change that — see
  // cv/eligibility.mjs.
  //
  // Other providers are unaffected: `web_client` is honestly limited and
  // `local_test` is test-only and already cannot reach production.
  // NOTE ON THE CONSTANT ABOVE. `PROD_PROVIDER_ID` is 'web_client' ("the best
  // honest provider available here"); it does NOT mean production_cv.
  // Comparing against it would hand production_cv its OBSERVATION list and
  // open the gate completely, so the comparison is against the literal CV
  // provider id.
  const combineCapsFor = (providerId, protocolId) => {
    const prov = PROVIDERS[providerId];
    if (!prov) return [];
    if (providerId !== CV_PROVIDER_ID) return prov.capabilities ?? [];
    return combineCapabilities(protocolId, { providerCapabilities: prov.capabilities ?? [] });
  };

  // Rate limits: attempt creation and request creation. The shared limiter and
  // its named policy (see domains/platform/rateLimit.mjs).
  const limited = limitCheck(ctx.rateLimit);

  // ------------------------------------------------------------- views
  const protocolPublic = (p) => ({
    id: p.id, version: p.version, title: p.title, category: p.category,
    description: p.description, metricType: p.metricType, metricUnit: p.metricUnit,
    direction: p.direction, precision: p.precision, protocolWindowMs: p.protocolWindowMs,
    requiredCapabilities: p.requiredCapabilities,
    // Honest, device-aware MEASUREMENT capability across the providers a
    // player can actually use, with production_cv gated by real-world
    // validation (its Combine list, never its observation list). Currently
    // this is web_client's honest list plus an empty CV list, so ball
    // protocols stay not_configured — which is the truth about MEASUREMENT.
    // The test/demo provider can simulate the rest.
    measurementCapability: measurementCapability(p, [
      ...combineCapsFor(PROD_PROVIDER_ID, p.id),
      ...combineCapsFor(CV_PROVIDER_ID, p.id),
    ]),
    // OBSERVATION capability, reported separately and never collapsed into the
    // line above: the CV engine can genuinely see these activities.
    observationCapability: measurementCapability(p, PROVIDERS[CV_PROVIDER_ID]?.capabilities ?? []),
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

  function boundSession(a) { return reads.sessions.byId(a.boxSessionId); }

  // Effective (live) Combine state: a Combine Verified result whose bound Box
  // Cam session is later invalidated by Trust & Safety immediately stops
  // counting; a restore brings it back. Computed at read time so invalidation
  // is reflected everywhere without rewriting the stored attempt.
  // The rule itself lives in combineShared.mjs as `liveCombineState` so the
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

  /** The player's attempts, newest created first. */
  const playerAttempts = (playerId) => reads.attempts.forPlayer(playerId);
  /** Verified attempts with their live state: the bound sessions read in one batch. */
  const verifiedAttempts = (playerId) => {
    const attempts = playerAttempts(playerId).filter((a) => a.combineState === 'combine_verified' && a.measuredValue != null);
    const sessions = new Map(reads.sessions.byIds(attempts.map((a) => a.boxSessionId)).map((s) => [s.id, s]));
    return attempts
      .map((a) => ({ ...a, effectiveState: liveCombineState(a, sessions.get(a.boxSessionId) ?? null) }))
      .filter((a) => a.effectiveState === 'combine_verified');
  };

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
  // Safe facts for other surfaces (Rooms, Watchlists) — factual
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
    const requests = reads.requests.forPlayer(player.id).filter((r) => r.state !== 'cancelled');
    return {
      verifiedResults: [...bests.values()].filter(Boolean).map((a) => attemptView(a)),
      personalBests: [...bests.values()].filter(Boolean).length,
      attempts: attempts.slice(0, 50).map((a) => attemptView(a)),
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
    res.json({ items: playerAttempts(req.player.id).slice(0, 100).map((a) => attemptView(a, { includeIntegrity: true })) });
  });
  playerRouter.get('/combine/attempts/:id', (req, res) => {
    const a = ownAttempt(req.player.id, req.params.id);
    if (!a) return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
    res.json({ attempt: attemptView(a, { includeIntegrity: true }) });
  });

  function ownAttempt(playerId, id) { const a = reads.attempts.byId(id); return a && a.playerId === playerId ? a : null; }

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
    const combineCaps = combineCapsFor(provider.id, proto.id);
    if (!measurementSupported(proto, combineCaps)) {
      vmetric('combine_measurement_provider_error');
      const observationOnly = measurementSupported(proto, provider.capabilities ?? []);
      return res.status(422).json({
        error: 'MEASUREMENT_NOT_SUPPORTED',
        message: observationOnly
          ? 'Box Cam can observe this activity, but Combine verification is not available yet for this protocol. Real-world validation has not been completed.'
          : 'This Combine measurement is not yet supported on this device. ScoutBox does not estimate or fabricate a result.',
        // Distinguishes "the engine cannot see this" from "the engine sees it
        // but is not permitted to certify it" — different facts, different
        // remedies, and collapsing them is how a blocker gets argued away.
        reason: observationOnly ? 'REAL_WORLD_VALIDATION_NOT_COMPLETED' : 'MEASUREMENT_NOT_SUPPORTED',
        observationSupported: observationOnly,
        missingCapabilities: proto.requiredCapabilities.filter((c) => !combineCaps.includes(c)),
      });
    }

    // Attempt limits apply to VERIFIED attempts only — practice is for
    // rehearsal and is generously (not punitively) capped.
    const since = Date.now() - proto.windowMs;
    if (mode === 'verified') {
      const recent = reads.attempts.count(req.player.id, proto.id, { mode: 'verified', since });
      if (recent >= proto.maxVerifiedPerWindow) return res.status(429).json({ error: 'ATTEMPT_LIMIT_REACHED', maxVerifiedPerWindow: proto.maxVerifiedPerWindow, message: 'You have used your verified attempts for this Combine. Practice attempts remain available.' });
    } else {
      const recentPractice = reads.attempts.count(req.player.id, proto.id, { mode: 'practice', since: Date.now() - 86_400_000 });
      if (recentPractice >= 20) return res.status(429).json({ error: 'RATE_LIMITED' });
    }

    let request = null;
    if (requestId) {
      request = reads.requests.byId(requestId);
      if (!request || request.playerId !== req.player.id || request.state === 'cancelled') return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
      if (!request.protocolIds.includes(proto.id)) return res.status(400).json({ error: 'PROTOCOL_NOT_IN_REQUEST' });
    }

    const drill = latestDrill(proto.drillId);
    if (!drill) return res.status(500).json({ error: 'PROTOCOL_DRILL_MISSING' });
    const attemptNumber = reads.attempts.count(req.player.id, proto.id) + 1;
    // One unit: the minted session and the attempt bound to it.
    const { session, nonce, attempt } = unit(() => {
      const minted = ctx.boxMintSession({ player: req.player, drill, target: { type: proto.drillTarget.type, value: proto.drillTarget.value }, provider, captureContext });
      const row = boxCam.attempts.create(newAttempt(minted.session));
      return { session: minted.session, nonce: minted.nonce, attempt: row };
    });
    function newAttempt(boxSession) { return {
      id: nextId('catt'), playerId: req.player.id,
      protocolId: proto.id, protocolVersion: proto.version,
      boxSessionId: boxSession.id, attemptNumber,
      mode, captureContext, requestId: request?.id ?? null,
      metricType: proto.metricType, metricUnit: proto.metricUnit, direction: proto.direction,
      measurementAlgorithmVersion: proto.measurementAlgorithmVersion,
      provider: provider.id, providerVersion: provider.version,
      calibrationResult: (proto.calibrationRequirements ?? []).length === 0
        ? { required: [], passed: true, checks: ['geometry_ready_check'], at: Date.now() } : null,
      measuredValue: null, measurementState: null, combineState: 'ready', reasons: [],
      startedAt: null, completedAt: null, resultHash: null, createdAt: Date.now(),
    }; }
    vmetric('combine_attempt_started');
    if (mode === 'practice') vmetric('combine_practice_started');
    res.status(201).json({
      attempt: attemptView(attempt, { includeIntegrity: true }),
      boxSession: ctx.boxSessionView(session),
      nonce, livenessChallenge: session.livenessChallenge,
      livenessNote: 'The liveness check establishes live-session presence. It is not identity verification.',
      expiresAt: session.expiresAt, protocol: protocolPublic(proto),
      readyCheck: { automated: ['camera_permission', 'camera_stream', 'device_orientation'], unableToCheckAutomatically: ['lighting', 'framing', 'space', 'single_participant'] },
      calibration: { required: proto.calibrationRequirements ?? [], note: (proto.calibrationRequirements ?? []).length ? 'This protocol needs a Box Marker for physical-scale calibration.' : 'No physical-scale calibration required — standardized geometry only.' },
    });
  });

  playerRouter.post('/combine/attempts/:id/calibrate', (req, res) => {
    const a = ownAttempt(req.player.id, req.params.id);
    if (!a) return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
    if (COMBINE_TERMINAL.has(a.combineState)) return res.status(409).json({ error: 'ALREADY_FINALIZED' });
    const proto = combineProtocol(a.protocolId, a.protocolVersion);
    const required = proto?.calibrationRequirements ?? [];
    // A list of check names as sent: anything else is refused, not turned into strings.
    const rawChecks = req.body?.checks;
    if (rawChecks !== undefined && (!Array.isArray(rawChecks) || rawChecks.length > 10 || rawChecks.some((c) => typeof c !== 'string' || !c.length || c.length > 60))) {
      return res.status(400).json({ error: 'FIELD_INVALID', field: 'checks', message: 'Calibration checks are a list of at most 10 check names.' });
    }
    const checks = rawChecks ?? [];
    // First-library protocols need standardized geometry only (passes when
    // the Ready Check geometry passes). Physical-scale calibration (Box
    // Marker) is required by future protocols, which are unsupported anyway.
    const passed = required.length === 0 ? true : required.every((r) => checks.includes(r));
    const next = boxCam.attempts.calibrate(a.id, { passed, checks: [...checks], at: Date.now() });
    res.json({ attempt: attemptView(next, { includeIntegrity: true }), calibrationPassed: passed });
  });

  // Complete: reuse the shared Box Cam completion path (finalize + hook).
  playerRouter.post('/combine/attempts/:id/complete', (req, res) => {
    const a = ownAttempt(req.player.id, req.params.id);
    if (!a) return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
    if (COMBINE_TERMINAL.has(a.combineState)) return res.status(409).json({ error: 'ALREADY_FINALIZED', message: 'A completed Combine Attempt cannot be submitted again.' });
    const s = boundSession(a);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (!nonceMatches(s, (req.body ?? {}).nonce)) return res.status(403).json({ error: 'NONCE_INVALID' });
    if (s.status !== 'recording') return res.status(409).json({ error: 'SESSION_NOT_RECORDING', status: s.status });
    const done = unit(() => {
      boxCam.attempts.markStarted(a.id, { startedAt: s.startedAt });
      return ctx.boxCompleteSession(s.id, req.player); // -> onSessionFinalized -> applyCombineProgress
    });
    res.json({ attempt: attemptView(reads.attempts.byId(a.id), { includeIntegrity: true }), boxSession: ctx.boxSessionView(done) });
  });

  playerRouter.post('/combine/attempts/:id/cancel', (req, res) => {
    const a = ownAttempt(req.player.id, req.params.id);
    if (!a) return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
    if (COMBINE_TERMINAL.has(a.combineState)) return res.status(409).json({ error: 'ALREADY_FINALIZED' });
    const s = boundSession(a);
    const next = unit(() => {
      if (s && s.status === 'recording') boxCam.sessions.cancel(s.id);
      return boxCam.attempts.cancel(a.id, { at: Date.now() });
    });
    res.json({ attempt: attemptView(next) });
  });

  // -------------------------------- measurement derivation (server-side hook)
  // Runs inside the session's completion unit of work.
  function applyCombineProgress(session, player) {
    let a = reads.attempts.bySession(session.id);
    if (!a || COMBINE_TERMINAL.has(a.combineState)) return;
    const proto = combineProtocol(a.protocolId, a.protocolVersion);
    const provider = PROVIDERS[session.provider];
    const calibrationPassed = a.calibrationResult ? a.calibrationResult.passed : (proto?.calibrationRequirements ?? []).length === 0;
    const r = measureAttempt({
      protocolDef: proto, session,
      calibrationPassed,
      // The Combine-eligible list, never the observation list.
      providerCapabilities: combineCapsFor(session.provider, a.protocolId),
      mode: a.mode,
    });
    const measured = { measuredValue: r.measuredValue, measurementState: r.measurementState, combineState: r.combineState, completedAt: Date.now() };
    a = boxCam.attempts.measure(a.id, { ...measured, reasons: r.reasons ?? [], resultHash: combineResultHash({ ...a, ...measured }) });
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
    // A deadline is a DATE_ONLY covering the whole day; an unreadable
    // one is a window that has already closed, never one that stays open.
    const deadlineMs = r.deadline ? (endOfDayExclusive(r.deadline) ?? -Infinity) : Infinity;
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
    for (const r of reads.requests.forPlayer(player.id).filter((x) => x.state === 'requested')) {
      if (requiredDone(r).size >= r.protocolIds.length) {
        boxCam.requests.complete(r.id, { at: Date.now() });
        vmetric('combine_request_completed');
        const org = byId.org(r.orgId);
        const lead = byId.user(r.requestedBy?.userId, (u) => !u.removedAt);
        if (lead) notify({ kind: 'org_user', id: lead.id }, 'combine', `${player.name} completed your Club Combine${r.title ? `: ${r.title}` : ''}.`, r.id);
        ledgerAppend?.({ type: 'combine_request_completed', playerId: player.id, orgId: r.orgId, orgName: org?.name, detail: { requestId: r.id } });
      }
    }
  }

  playerRouter.get('/combine/requests', (req, res) => {
    res.json({ items: reads.requests.forPlayer(req.player.id).filter((r) => r.state !== 'cancelled').map(requestView) });
  });
  guardianRouter.get('/children/:id/combine/requests', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    res.json({ items: reads.requests.forPlayer(req.params.id).filter((r) => r.state !== 'cancelled').map(requestView) });
  });

  // ================================================================== CLUB
  // The one creator for Club Combine requests. Extracted from the route so a
  // Recruitment Room can raise a request through exactly this code path
  // instead of growing a second copy of it. Callers do their own eligibility,
  // rate-limit and moderation checks first — this only creates.
  function createRequests({ org, orgUser, playerIds, protocolIds, title, deadline, instructions }) {
    const created = [];
    const skipped = [];
    // One unit: every request, its ledger row and its notification commit together.
    unit(() => { for (const pid of playerIds) {
      const p = findPlayer(pid);
      // Standing gates hold exactly as elsewhere — a request never widens access.
      if (!p || !orgCanSee(org, p)) { skipped.push({ playerId: pid, reason: p ? 'NOT_VISIBLE' : 'PLAYER_NOT_FOUND' }); continue; }
      const r = boxCam.requests.create({
        id: nextId('creq'), orgId: org.id, orgName: org.name,
        requestedBy: { userId: orgUser.id, name: orgUser.name, role: orgUser.role ?? null, at: Date.now() },
        playerId: p.id, title: String(title ?? '').trim().slice(0, 120) || null,
        protocolIds, deadline: deadline || null,
        instructions: instructions ? String(instructions).slice(0, 300) : null,
        state: 'requested', createdAt: Date.now(), completedAt: null,
      });
      created.push(r);
      ledgerAppend?.({ type: 'combine_request_created', playerId: p.id, orgId: org.id, orgName: org.name, userId: orgUser.id, scoutName: orgUser.name, detail: { requestId: r.id, protocols: protocolIds } });
      const msg = `${org.name} requested an At-Home Combine${r.title ? `: ${r.title}` : ''} (${protocolIds.length} test${protocolIds.length > 1 ? 's' : ''}). Powered by Box Cam.`;
      if (!isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'combine', `${p.name}: ${msg}`, r.id);
      else notify({ kind: 'player', id: p.id }, 'combine', msg, r.id);
    } });
    vmetric('combine_request_created', created.length);
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
    // Protocol and player ids are text as sent: anything else is refused, not turned into strings.
    if (protocolIds !== undefined && (!Array.isArray(protocolIds) || protocolIds.some((x) => typeof x !== 'string'))) return res.status(400).json({ error: 'FIELD_INVALID', field: 'protocolIds', message: 'protocolIds is a list of protocol ids.' });
    if (req.body?.playerIds !== undefined && (!Array.isArray(req.body.playerIds) || req.body.playerIds.some((x) => typeof x !== 'string'))) return res.status(400).json({ error: 'FIELD_INVALID', field: 'playerIds', message: 'playerIds is a list of player ids.' });
    if (title !== undefined && title !== null && typeof title !== 'string') return res.status(400).json({ error: 'FIELD_INVALID', field: 'title', message: 'A title is text.' });
    const ids = Array.isArray(protocolIds) ? [...new Set(protocolIds)] : [];
    if (ids.length === 0) return res.status(400).json({ error: 'PROTOCOLS_REQUIRED' });
    if (ids.length > 20) return res.status(400).json({ error: 'FIELD_INVALID', field: 'protocolIds', message: 'A Club Combine asks for at most 20 protocols.' });
    if (!isAbsent(deadline) && !parseStrictDateOnly(deadline).ok) return res.status(400).json({ error: 'DATE_INVALID', field: 'deadline', message: 'A deadline is a calendar day written YYYY-MM-DD.', expected: 'YYYY-MM-DD' });
    for (const pid of ids) {
      const proto = latestCombineProtocol(pid);
      if (!proto || proto.status !== 'active') return res.status(404).json({ error: 'PROTOCOL_UNKNOWN', protocolId: pid });
    }
    const playerIds = Array.isArray(req.body?.playerIds) ? req.body.playerIds : (req.body?.playerId ? [String(req.body.playerId)] : []);
    if (playerIds.length === 0) return res.status(400).json({ error: 'PLAYERS_REQUIRED' });
    if (instructions && !moderateOrRefuse(res, String(instructions), { kind: 'combine_request', orgId: req.org.id })) return;

    const { created, skipped } = createRequests({ org: req.org, orgUser: req.orgUser, playerIds, protocolIds: ids, title, deadline, instructions });
    if (created.length > 1 || playerIds.length > 1) vmetric('club_combine_created');
    res.status(created.length ? 201 : 409).json({ requests: created.map(requestView), skipped });
  });

  orgRouter.get('/combine/requests', (req, res) => {
    // Bounded by one club's requests: the visibility rule applied in code, then the page cut.
    const mine = reads.requests.forOrg(req.org.id, { playerId: req.query.playerId ? String(req.query.playerId) : null })
      .filter((r) => { const p = findPlayer(r.playerId); return p && orgCanSee(req.org, p); });
    const page = pageNewestFirst(req, res, mine, { readPage, pageOf, sendPageError });
    if (!page) return;
    res.json({ items: page.items.map(requestView), nextCursor: page.nextCursor });
  });

  orgRouter.post('/combine/requests/:id/cancel', (req, res) => {
    const r = reads.requests.byId(req.params.id);
    if (!r || r.orgId !== req.org.id) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
    if (r.state === 'completed') return res.status(409).json({ error: 'ALREADY_COMPLETED' });
    const next = boxCam.requests.cancel(r.id);
    res.json({ request: requestView(next) });
  });

  // Club sees a visible player's verified Combine results (recruitment-safe).
  // Access requires the standing gates AND either the player's recruitment
  // opt-in OR an active/completed request from THIS org (responding to a
  // request implies consent). Never raw video, DOB, notes or integrity.
  function orgMaySeeResults(org, p) {
    if (!orgCanSee(org, p)) return false;
    if (reads.prefs.sharesForRecruitment(p.id)) return true;
    return reads.requests.activeBetween(org.id, p.id);
  }
  // Shared with the Recruitment Rooms so a Room applies the identical consent rule
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
    const a = reads.attempts.byId(req.params.id);
    if (!a) return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
    res.json({ attempt: attemptView(a, { includeIntegrity: true }), boxSession: ctx.boxSessionView(boundSession(a) ?? {}, { includeIntegrity: true }) });
  });

  return { attemptView, combineProjection, myCombine };
}
