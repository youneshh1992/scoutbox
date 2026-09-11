// M18 — Recruitment Briefs and Nobody Missed.
//
// A Recruitment Brief is an EXPLICIT expression of what a club is looking for.
// It is not a talent model, it has no weights, and it has no hidden criteria:
// every rule is boolean and every candidate can answer "why is this player
// here?" with the same list the club typed in.
//
// The order of operations below is the whole safeguarding story and never
// changes:
//
//   organisation standing → player visibility → blocks / minors / radius
//   → brief eligibility → evaluation history → Nobody Missed
//
// Hidden players never enter the candidate set. They are not matched and then
// concealed — concealment after matching is how side channels are born.
import { PROVIDERS } from '../m16/drills.mjs';
import {
  validateRecruitmentBrief, explainBriefCriteria, playerMatchesBrief,
  buildNobodyMissedCandidate, evaluationCoverageState, isMeaningfullyEvaluated,
  BRIEF_STATUSES, canBriefTransition, EVALUATION_COVERAGE_POLICY_VERSION,
  COVERAGE_POLICY, EVALUATION_SIGNALS, NON_EVALUATION_SIGNALS,
  NOBODY_MISSED_STATES, NM_DISMISSAL_REASONS, NM_SORTS, orderNobodyMissed,
  EVIDENCE_REQUIREMENTS, POSITIONS, TRUST_BANDS, LIMITS, clampPage,
} from './shared.mjs';

export function registerNobodyMissed(ctx) {
  const {
    db, orgRouter, nextId, persistNow, findPlayer, orgCanSee,
    isLead, requireLead, playerViewForOrg, audit, vmetric, suppress,
  } = ctx;

  const now = () => Date.now();
  const buckets = new Map();
  function limited(key, max, windowMs) {
    const t = now();
    const b = buckets.get(key);
    if (!b || t - b.start > windowMs) { buckets.set(key, { start: t, n: 1 }); return false; }
    b.n += 1;
    return b.n > max;
  }
  const SUPPRESS_MIN = 3;

  // ------------------------------------------------------------ match facts

  /**
   * The lightweight per-player projection matching runs against. Only fields a
   * brief can legitimately test, and only fields this organisation could
   * already read — assembled from the existing org view, never a full Passport.
   */
  function matchFacts(player, org) {
    const view = playerViewForOrg(player, org);
    if (!view) return null;
    const prefs = (db.passportPrefs ?? []).find((p) => p.playerId === player.id) ?? null;
    const evidence = db.evidence.filter((e) => e.playerId === player.id && !e.supersededBy);
    const recentFullMatch = evidence.some((e) => e.claimType === 'footage' && e.recordedAt > now() - 180 * 86_400_000);
    const coachReference = (db.verReferences ?? []).some((r) => r.playerId === player.id && r.status === 'active')
      || evidence.some((e) => e.verification?.status === 'coach_confirmed');
    // Production-valid Combine only: a simulated result never becomes
    // production recruitment eligibility.
    const combineProtocols = (db.combineAttempts ?? [])
      .filter((a) => a.playerId === player.id && a.combineState === 'combine_verified' && !PROVIDERS[a.provider]?.testOnly)
      .filter((a) => (db.boxSessions ?? []).find((s) => s.id === a.boxSessionId)?.verificationState !== 'invalidated')
      .map((a) => a.protocolId);
    const trust = ctx.trustSummaryFor?.(player) ?? null;
    const clubConfirmed = (db.squads ?? []).length >= 0 && !!(db.signings ?? []).find((s) => s.playerId === player.id);

    return {
      playerId: player.id,
      name: view.name,
      age: view.age ?? null,
      position: prefs?.positions?.primary ?? view.position ?? null,
      secondaryPositions: prefs?.positions?.secondary ?? [],
      level: view.level ?? null,
      foot: view.foot ?? null,
      availability: prefs?.availability ?? view.availability ?? null,
      distanceKm: view.distanceKm ?? null,
      trustBand: trust?.band ?? null,
      combineProtocols,
      evidenceFlags: {
        recent_full_match: recentFullMatch,
        coach_reference: coachReference,
        confirmed_current_club: clubConfirmed,
        combine_verified: combineProtocols.length > 0,
      },
      lastEvidenceAt: evidence.reduce((m, e) => Math.max(m, e.recordedAt ?? 0), 0) || null,
    };
  }

  /**
   * Has this organisation meaningfully evaluated this player? Reads the nine
   * signals the coverage policy names. A profile view and a search impression
   * are deliberately absent — looking at somebody is not evaluating them.
   */
  function evaluationSignals(playerId, org) {
    const cases = db.recruitmentCases.filter((c) => c.orgId === org.id && c.playerId === playerId);
    const rooms = cases.filter((c) => c.room);
    const openRoom = rooms.find((c) => !['signed', 'withdrawn', 'archived', 'closed'].includes(c.room.status));
    const endedRooms = rooms.filter((c) => ['signed', 'withdrawn', 'archived', 'closed'].includes(c.room.status));
    const decisions = (db.roomDecisions ?? []).filter((d) => d.orgId === org.id && d.playerId === playerId);
    const lastDecisionAt = decisions.reduce((m, d) => Math.max(m, d.createdAt ?? 0), 0) || null;
    return {
      room_open: !!openRoom,
      room_decided: endedRooms.length > 0 || decisions.length > 0,
      case_open: cases.some((c) => !c.room && c.stage !== 'closed'),
      assessment_submitted: db.assessments.some((a) => a.orgId === org.id && a.playerId === playerId && a.state !== 'draft'),
      trial: (db.trials ?? []).some((t) => t.orgId === org.id && t.playerId === playerId),
      signing: (db.signings ?? []).some((s) => s.orgId === org.id && s.playerId === playerId),
      shortlisted: (db.ledger ?? []).some((l) => l.type === 'shortlist' && l.orgId === org.id && l.playerId === playerId),
      review_deferred: (db.reviewLater ?? []).some((r) => r.orgId === org.id && r.playerId === playerId && r.dueAt > now()),
      squad: (org.squad ?? []).some((s) => s.playerId === playerId),
      lastDecisionAt,
      openRoomId: openRoom?.id ?? null,
    };
  }
  ctx.m18EvaluationSignals = evaluationSignals;

  // ----------------------------------------------------------------- briefs

  const briefsFor = (orgId) => (db.recruitmentBriefs ?? []).filter((b) => b.orgId === orgId);

  function findBrief(req, res) {
    const b = (db.recruitmentBriefs ?? []).find((x) => x.id === req.params.id && x.orgId === req.org.id);
    // A foreign brief is indistinguishable from one that does not exist.
    if (!b) { res.status(404).json({ error: 'BRIEF_NOT_FOUND' }); return null; }
    return b;
  }

  const briefView = (b) => ({
    id: b.id, title: b.title, status: b.status, version: b.version,
    criteria: b.criteria, criteriaExplained: explainBriefCriteria(b.criteria),
    activeFrom: b.activeFrom, activeUntil: b.activeUntil,
    roleId: b.roleId ?? null, vacancyId: b.vacancyId ?? null,
    createdBy: b.createdBy, createdAt: b.createdAt, updatedAt: b.updatedAt,
    note: 'These are the only criteria used. There are no hidden criteria, no weights and no ranking.',
  });

  orgRouter.get('/recruitment-briefs', (req, res) => {
    const list = briefsFor(req.org.id).slice().sort((a, b) => b.updatedAt - a.updatedAt);
    const limit = clampPage(req.query.limit);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json({
      items: list.slice(offset, offset + limit).map(briefView),
      total: list.length, limit, offset,
      statuses: BRIEF_STATUSES,
      vocabulary: { positions: POSITIONS, evidenceRequirements: EVIDENCE_REQUIREMENTS, trustBands: TRUST_BANDS },
      policyVersion: EVALUATION_COVERAGE_POLICY_VERSION,
    });
  });

  orgRouter.post('/recruitment-briefs', (req, res) => {
    if (!requireLead(req, res)) return;
    if (limited(`brief:w:${req.org.id}`, LIMITS.briefWritesPerHour, 3_600_000)) return res.status(429).json({ error: 'RATE_LIMITED' });
    if (briefsFor(req.org.id).length >= LIMITS.briefsPerOrg) return res.status(409).json({ error: 'BRIEFS_FULL' });
    const v = validateRecruitmentBrief(req.body ?? {}, { orgLevel: req.org.level });
    // An invalid brief is refused, never silently repaired.
    if (!v.ok) return res.status(400).json(v);

    const b = {
      id: nextId('brf'), orgId: req.org.id, title: v.title,
      criteria: v.criteria, version: 1, status: 'draft',
      activeFrom: v.activeFrom, activeUntil: v.activeUntil,
      roleId: req.body?.roleId ?? null, vacancyId: req.body?.vacancyId ?? null,
      createdBy: { userId: req.orgUser.id, name: req.orgUser.name },
      createdAt: now(), updatedAt: now(), history: [],
    };
    audit(b, 'org', req.orgUser.id, req.orgUser.name, 'recruitment_brief_created', { version: 1 });
    db.recruitmentBriefs.push(b);
    vmetric('recruitment_brief_created');
    persistNow();
    res.status(201).json({ brief: briefView(b) });
  });

  orgRouter.get('/recruitment-briefs/:id', (req, res) => {
    const b = findBrief(req, res);
    if (!b) return;
    res.json({ brief: briefView(b) });
  });

  orgRouter.patch('/recruitment-briefs/:id', (req, res) => {
    const b = findBrief(req, res);
    if (!b) return;
    if (!requireLead(req, res)) return;
    if (limited(`brief:w:${req.org.id}`, LIMITS.briefWritesPerHour, 3_600_000)) return res.status(429).json({ error: 'RATE_LIMITED' });
    if (b.status === 'archived') return res.status(409).json({ error: 'BRIEF_ARCHIVED' });

    if (req.body?.status !== undefined) {
      const to = String(req.body.status);
      if (!BRIEF_STATUSES.includes(to)) return res.status(400).json({ error: 'BRIEF_STATUS_UNKNOWN' });
      if (!canBriefTransition(b.status, to)) return res.status(409).json({ error: 'BRIEF_TRANSITION_INVALID', from: b.status, to });
      const from = b.status;
      b.status = to;
      audit(b, 'org', req.orgUser.id, req.orgUser.name, to === 'active' ? 'recruitment_brief_activated' : 'recruitment_brief_updated', { from, to });
      if (to === 'active') vmetric('recruitment_brief_activated');
    }

    const wantsCriteria = ['title', 'positions', 'minAge', 'maxAge', 'radiusKm', 'maxLevel', 'foot', 'availability', 'evidenceRequirements', 'minTrustBand', 'combineProtocols', 'activeFrom', 'activeUntil']
      .some((k) => req.body?.[k] !== undefined);
    if (wantsCriteria) {
      const merged = { title: b.title, ...b.criteria, activeFrom: b.activeFrom, activeUntil: b.activeUntil, ...req.body };
      delete merged.status;
      const v = validateRecruitmentBrief(merged, { orgLevel: req.org.level });
      if (!v.ok) return res.status(400).json(v);
      const changed = JSON.stringify(v.criteria) !== JSON.stringify(b.criteria);
      b.title = v.title;
      b.activeFrom = v.activeFrom;
      b.activeUntil = v.activeUntil;
      if (changed) {
        // A material criteria change is a NEW version. Historical coverage keeps
        // pointing at the version it was computed against.
        b.criteria = v.criteria;
        b.version += 1;
        audit(b, 'org', req.orgUser.id, req.orgUser.name, 'recruitment_brief_updated', { version: b.version, criteriaChanged: true });
      }
    }
    b.updatedAt = now();
    persistNow();
    res.json({ brief: briefView(b) });
  });

  // --------------------------------------------------------- nobody missed

  const briefIsLive = (b) => {
    if (b.status !== 'active') return false;
    const today = new Date().toISOString().slice(0, 10);
    if (b.activeFrom && today < String(b.activeFrom)) return false;
    if (b.activeUntil && today > String(b.activeUntil)) return false;
    return true;
  };

  const reviewFor = (orgId, briefId, playerId) => (db.nobodyMissedReviews ?? [])
    .find((r) => r.orgId === orgId && r.briefId === briefId && r.playerId === playerId) ?? null;

  /**
   * Compute the brief's candidate set. Gates first, always.
   */
  function computeBrief(req, brief) {
    const org = req.org;
    const eligible = [];
    const evaluatedIds = [];
    const candidates = [];
    let scanned = 0;

    for (const player of db.players) {
      if (++scanned > LIMITS.maxCandidateScan) break;
      // 1-3: standing, visibility, blocks/minors/radius. A player who fails
      // here never becomes a candidate at all.
      if (!orgCanSee(org, player)) continue;
      const facts = matchFacts(player, org);
      if (!facts) continue;
      // 4: the club's own explicit criteria.
      const match = playerMatchesBrief(facts, brief.criteria);
      if (!match.matched) continue;
      eligible.push(facts.playerId);

      // 5: this organisation's evaluation history.
      const signals = evaluationSignals(player.id, org);
      const evaluation = isMeaningfullyEvaluated(signals);
      if (evaluation.evaluated) { evaluatedIds.push(facts.playerId); continue; }

      const candidate = buildNobodyMissedCandidate({
        facts, brief, match, evaluation, roomOpen: !!signals.openRoomId,
      });
      if (!candidate) continue;
      const review = reviewFor(org.id, brief.id, player.id);
      if (review && ['dismissed', 'added_to_room'].includes(review.state)) continue;
      candidates.push({
        ...candidate,
        distanceKm: facts.distanceKm,
        lastEvidenceAt: facts.lastEvidenceAt,
        state: review?.state ?? 'open',
        reviewedAt: review?.reviewedAt ?? null,
      });
    }

    return { eligible, evaluatedIds, candidates };
  }

  orgRouter.get('/nobody-missed', (req, res) => {
    const briefId = String(req.query.briefId ?? '');
    const brief = (db.recruitmentBriefs ?? []).find((b) => b.id === briefId && b.orgId === req.org.id);
    if (!brief) return res.status(404).json({ error: 'BRIEF_NOT_FOUND' });
    if (!briefIsLive(brief)) {
      return res.json({
        brief: briefView(brief), live: false, items: [], total: 0,
        coverage: null,
        note: 'Only an active brief inside its date window produces candidates.',
      });
    }
    const { eligible, evaluatedIds, candidates } = computeBrief(req, brief);
    const coverage = evaluationCoverageState({
      eligible: eligible.length, evaluated: evaluatedIds.length, suppressMin: SUPPRESS_MIN,
    });
    const sort = NM_SORTS.includes(String(req.query.sort)) ? String(req.query.sort) : 'newest_evidence';
    const ordered = orderNobodyMissed(candidates, sort);
    const limit = clampPage(req.query.limit);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json({
      brief: briefView(brief), live: true,
      briefVersion: brief.version,
      items: ordered.slice(offset, offset + limit),
      total: ordered.length, limit, offset,
      coverage,
      sorts: NM_SORTS, sort,
      evaluationPolicy: {
        version: EVALUATION_COVERAGE_POLICY_VERSION,
        counts: EVALUATION_SIGNALS, doesNotCount: NON_EVALUATION_SIGNALS,
        recentDecisionDays: COVERAGE_POLICY.recentDecisionDays,
      },
      note: 'Eligible under your own criteria and not yet in your evaluation workflow. This is workflow coverage, not a judgement of any player, and nothing here is ranked by quality.',
    });
  });

  const setReview = (req, brief, playerId, patch) => {
    let r = reviewFor(req.org.id, brief.id, playerId);
    if (!r) {
      r = {
        id: nextId('nmr'), orgId: req.org.id, briefId: brief.id, briefVersion: brief.version,
        playerId, state: 'open', createdAt: now(), updatedAt: now(), history: [],
      };
      db.nobodyMissedReviews.push(r);
    }
    Object.assign(r, patch, { updatedAt: now(), briefVersion: brief.version });
    r.history.push({ at: now(), state: r.state, by: { userId: req.orgUser.id, name: req.orgUser.name } });
    persistNow();
    return r;
  };

  function briefAndPlayer(req, res) {
    const brief = (db.recruitmentBriefs ?? []).find((b) => b.id === String(req.body?.briefId ?? req.params.briefId) && b.orgId === req.org.id);
    if (!brief) { res.status(404).json({ error: 'BRIEF_NOT_FOUND' }); return null; }
    const player = findPlayer(String(req.body?.playerId ?? req.params.playerId));
    if (!player || !orgCanSee(req.org, player)) { res.status(403).json({ error: 'NOT_VISIBLE' }); return null; }
    return { brief, player };
  }

  orgRouter.post('/nobody-missed/review', (req, res) => {
    const ctxp = briefAndPlayer(req, res);
    if (!ctxp) return;
    if (limited(`nm:act:${req.org.id}`, LIMITS.reviewActionsPerHour, 3_600_000)) return res.status(429).json({ error: 'RATE_LIMITED' });
    const r = setReview(req, ctxp.brief, ctxp.player.id, {
      state: 'reviewed', reviewedBy: { userId: req.orgUser.id, name: req.orgUser.name }, reviewedAt: now(),
    });
    vmetric('nobody_missed_player_reviewed');
    res.json({ review: r, note: 'Reviewing a candidate records nothing on the player’s own record.' });
  });

  orgRouter.post('/nobody-missed/dismiss', (req, res) => {
    const ctxp = briefAndPlayer(req, res);
    if (!ctxp) return;
    if (limited(`nm:act:${req.org.id}`, LIMITS.reviewActionsPerHour, 3_600_000)) return res.status(429).json({ error: 'RATE_LIMITED' });
    const reason = req.body?.reason ?? null;
    if (reason != null && !NM_DISMISSAL_REASONS.includes(reason)) {
      return res.status(400).json({ error: 'NM_REASON_UNKNOWN', allowed: NM_DISMISSAL_REASONS });
    }
    const r = setReview(req, ctxp.brief, ctxp.player.id, {
      state: 'dismissed', dismissReason: reason, dismissedBy: { userId: req.orgUser.id, name: req.orgUser.name }, dismissedAt: now(),
    });
    vmetric('nobody_missed_player_dismissed');
    // Dismissal is scoped to THIS brief. It is not a global rejection and it is
    // never written to the player's Passport.
    res.json({ review: r, note: 'Dismissed for this brief only. Nothing is written to the player’s record.' });
  });

  /**
   * Add a candidate to a Recruitment Room. Bridges M17's canonical creator, so
   * the room, its visibility check and its uniqueness rule are all M17's.
   */
  orgRouter.post('/nobody-missed/add-to-room', (req, res) => {
    const ctxp = briefAndPlayer(req, res);
    if (!ctxp) return;
    if (limited(`nm:act:${req.org.id}`, LIMITS.reviewActionsPerHour, 3_600_000)) return res.status(429).json({ error: 'RATE_LIMITED' });
    if (!ctx.createRoomForPlayer) return res.status(503).json({ error: 'ROOM_ENGINE_UNAVAILABLE' });
    const out = ctx.createRoomForPlayer({
      req, player: ctxp.player, sourceContext: 'nobody_missed',
      sourceRef: { briefId: ctxp.brief.id, briefVersion: ctxp.brief.version },
    });
    if (!out.ok) return res.status(out.status).json(out);
    const r = setReview(req, ctxp.brief, ctxp.player.id, {
      state: 'added_to_room', roomId: out.roomId,
      reviewedBy: { userId: req.orgUser.id, name: req.orgUser.name }, reviewedAt: now(),
    });
    vmetric('nobody_missed_player_added_to_room');
    res.status(201).json({ review: r, roomId: out.roomId, room: out.room });
  });

  /** Organisation-private coverage across every live brief. */
  orgRouter.get('/evaluation-coverage', (req, res) => {
    const items = briefsFor(req.org.id).filter(briefIsLive).map((brief) => {
      const { eligible, evaluatedIds } = computeBrief(req, brief);
      return {
        briefId: brief.id, title: brief.title, briefVersion: brief.version,
        coverage: evaluationCoverageState({ eligible: eligible.length, evaluated: evaluatedIds.length, suppressMin: SUPPRESS_MIN }),
      };
    });
    res.json({
      items,
      policyVersion: EVALUATION_COVERAGE_POLICY_VERSION,
      note: COVERAGE_POLICY.note,
    });
  });

  ctx.m18ComputeBrief = computeBrief;
  ctx.m18MatchFacts = matchFacts;
  void NOBODY_MISSED_STATES; void isLead; void suppress;
}
