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
import { PROVIDERS } from '../development/boxcam/drills.mjs';
import {
  validateRecruitmentBrief, explainBriefCriteria, playerMatchesBrief,
  buildNobodyMissedCandidate, evaluationCoverageState, isMeaningfullyEvaluated,
  BRIEF_STATUSES, canBriefTransition, EVALUATION_COVERAGE_POLICY_VERSION,
  COVERAGE_POLICY, EVALUATION_SIGNALS, NON_EVALUATION_SIGNALS,
  NOBODY_MISSED_STATES, NM_DISMISSAL_REASONS, NM_SORTS, orderNobodyMissed,
  EVIDENCE_REQUIREMENTS, POSITIONS, TRUST_BANDS, LIMITS, clampPage, briefIsLiveOn,
} from './shared.mjs';
import { rateLimitedBody } from '../platform/rateLimit.mjs';
import { guardRev, bumpRev, revMeta } from '../platform/concurrency.mjs';

export function registerNobodyMissed(ctx) {
  const {
    db, players, orgRouter, nextId, findPlayer, orgCanSee,
    isLead, requireLead, playerViewForOrg, audit, vmetric, suppress, discovery, unit,
  } = ctx;
  // S12c: briefs and reviews are rows of the discovery repository, written only through its operations.
  const dreads = ctx.discoveryReads;
  if (typeof dreads?.briefs?.forOrg !== 'function' || typeof discovery?.briefs?.create !== 'function') throw new TypeError('registerNobodyMissed needs the discovery repository and discoveryReads from the data layer');
  // §4.3 step 2: the signings are read through SQL (the signings repository's queries).
  const reads = ctx.recruitmentReads;
  if (typeof reads?.signings?.forPlayer !== 'function') throw new TypeError('registerNobodyMissed needs recruitmentReads (signings) from the data layer');

  const now = () => Date.now();
  // M18.1: the shared limiter and its named policy (see domains/platform/rateLimit.mjs).
  const limited = (action, keyPart) => !!ctx.rateLimit?.limited(action, keyPart);
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
    const prefs = ctx.verificationReads.passportPrefs.forPlayer(player.id); // S10b: null until the player saves preferences
    const evidence = ctx.scoutingReads.evidence.currentForPlayer(player.id);
    const recentFullMatch = evidence.some((e) => e.claimType === 'footage' && e.recordedAt > now() - 180 * 86_400_000);
    // M19 needs the DATE, not only the 180-day boolean, so a club can write
    // its own recency criterion ("within 90 days") instead of inheriting ours.
    const lastFootageAt = evidence
      .filter((e) => e.claimType === 'footage')
      .reduce((m, e) => Math.max(m, e.recordedAt ?? 0), 0) || null;
    const coachReference = ctx.verificationReads.references.hasActive(player.id)
      || evidence.some((e) => e.verification?.status === 'coach_confirmed');
    // Production-valid Combine only: a simulated result never becomes
    // production recruitment eligibility.
    // S12b: the player's verified production attempts and their bound sessions, read through SQL once.
    const verifiedAttempts = [...ctx.boxCamReads.attempts.forPlayer(player.id)].reverse()
      .filter((a) => a.combineState === 'combine_verified' && !PROVIDERS[a.provider]?.testOnly);
    const boundSessions = new Map(ctx.boxCamReads.sessions.byIds(verifiedAttempts.map((a) => a.boxSessionId)).map((s) => [s.id, s]));
    const liveAttempts = verifiedAttempts.filter((a) => boundSessions.get(a.boxSessionId)?.verificationState !== 'invalidated');
    const combineProtocols = liveAttempts.map((a) => a.protocolId);
    // M19 combine thresholds read the best production-valid measurement per
    // protocol. Simulated and invalidated results are already excluded above,
    // so a demo result can never satisfy a production threshold.
    const combineMeasurements = {};
    for (const a of liveAttempts) {
      const v = Number(a.measuredValue);
      if (!Number.isFinite(v)) continue;
      combineMeasurements[a.protocolId] = combineMeasurements[a.protocolId] == null ? v : Math.max(combineMeasurements[a.protocolId], v);
    }
    const trust = ctx.trustSummaryFor?.(player) ?? null;
    // M23-D2: this read `(db.squads ?? []).length >= 0 && …`. There is no
    // `db.squads` anywhere in the product — squad membership is org_squad_members (S9c),
    // per organisation — and `[].length >= 0` is true for every possible
    // value, so the conjunct could never change the result. Removing it is
    // behaviour-preserving and removes a production read of a store that does
    // not exist, which is exactly the drift the store inventory now catches.
    const clubConfirmed = reads.signings.forPlayer(player.id).length > 0;

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
      lastFootageAt,
      combineMeasurements,
    };
  }

  /**
   * Has this organisation meaningfully evaluated this player? Reads the nine
   * signals the coverage policy names. A profile view and a search impression
   * are deliberately absent — looking at somebody is not evaluating them.
   */
  function evaluationSignals(playerId, org) {
    const cases = reads.cases.forOrgPlayer(org.id, playerId);
    const rooms = cases.filter((c) => c.room);
    const openRoom = rooms.find((c) => !['signed', 'withdrawn', 'archived', 'closed'].includes(c.room.status));
    const endedRooms = rooms.filter((c) => ['signed', 'withdrawn', 'archived', 'closed'].includes(c.room.status));
    const decisions = reads.decisions.forOrgPlayer(org.id, playerId);
    const lastDecisionAt = decisions.reduce((m, d) => Math.max(m, d.createdAt ?? 0), 0) || null;
    return {
      room_open: !!openRoom,
      room_decided: endedRooms.length > 0 || decisions.length > 0,
      case_open: cases.some((c) => !c.room && c.stage !== 'closed'),
      assessment_submitted: ctx.scoutingReads.assessments.forOrgPlayer(org.id, playerId).some((a) => a.state !== 'draft'),
      trial: reads.trials.forOrgPlayer(org.id, playerId).length > 0,
      signing: reads.signings.forOrgPlayer(org.id, playerId).length > 0,
      shortlisted: ctx.safetyReads.ledger.isListedBy(org.id, playerId),
      review_deferred: ctx.insightReads.reviewLater.isDeferred(org.id, playerId, now()), // S12d
      // S9c: on the squad, or on the shadow list — either way the club has already considered the player.
      squad: ctx.scoutingReads.squad.has(org.id, playerId) || ctx.scoutingReads.shadow.has(org.id, playerId),
      lastDecisionAt,
      openRoomId: openRoom?.id ?? null,
    };
  }
  ctx.m18EvaluationSignals = evaluationSignals;

  // ----------------------------------------------------------------- briefs

  /** The organisation's briefs, most recently updated first. */
  const briefsFor = (orgId) => dreads.briefs.forOrg(orgId);

  function findBrief(req, res) {
    const b = dreads.briefs.forOrgById(String(req.params.id), req.org.id);
    // A foreign brief is indistinguishable from one that does not exist.
    if (!b) { res.status(404).json({ error: 'BRIEF_NOT_FOUND' }); return null; }
    return b;
  }

  const briefView = (b) => ({
    id: b.id, title: b.title, status: b.status, version: b.version,
    // `version` is the CRITERIA version historical coverage points at; `rev` is
    // the concurrency token that moves on every accepted write (M18.1).
    ...revMeta(b),
    criteria: b.criteria, criteriaExplained: explainBriefCriteria(b.criteria),
    activeFrom: b.activeFrom, activeUntil: b.activeUntil,
    roleId: b.roleId ?? null, vacancyId: b.vacancyId ?? null,
    createdBy: b.createdBy, createdAt: b.createdAt, updatedAt: b.updatedAt,
    note: 'These are the only criteria used. There are no hidden criteria, no weights and no ranking.',
  });

  orgRouter.get('/recruitment-briefs', (req, res) => {
    // At most LIMITS.briefsPerOrg per organisation, so the offset page stays.
    const list = briefsFor(req.org.id);
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
    if (limited('brief_write', req.org.id)) return res.status(429).json(rateLimitedBody('brief_write'));
    if (dreads.briefs.countForOrg(req.org.id) >= LIMITS.briefsPerOrg) return res.status(409).json({ error: 'BRIEFS_FULL' });
    const v = validateRecruitmentBrief(req.body ?? {}, { orgLevel: req.org.level, protocols: ctx.combineProtocolIds?.() ?? null });
    // An invalid brief is refused, never silently repaired.
    if (!v.ok) return res.status(400).json(v);
    // S12c: a role or vacancy reference is a short id, or absent; anything else is refused, never stored as it came.
    const refs = {};
    for (const k of ['roleId', 'vacancyId']) {
      const raw = req.body?.[k];
      if (raw === undefined || raw === null || raw === '') { refs[k] = null; continue; }
      if (typeof raw !== 'string' || raw.length > 64) return res.status(400).json({ error: 'FIELD_INVALID', field: k, message: `${k} must be an id of at most 64 characters.` });
      refs[k] = raw;
    }

    const at = now();
    const b = {
      id: nextId('brf'), orgId: req.org.id, title: v.title,
      criteria: v.criteria, version: 1, status: 'draft',
      activeFrom: v.activeFrom, activeUntil: v.activeUntil,
      roleId: refs.roleId, vacancyId: refs.vacancyId,
      createdBy: { userId: req.orgUser.id, name: req.orgUser.name },
      createdAt: at, updatedAt: at, history: [],
      rev: 1, revAt: at, revBy: { userId: req.orgUser.id, name: req.orgUser.name },
    };
    audit(b, 'org', req.orgUser.id, req.orgUser.name, 'recruitment_brief_created', { version: 1 });
    const stored = discovery.briefs.create(b);
    vmetric('recruitment_brief_created');
    res.status(201).json({ brief: briefView(stored) });
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
    if (limited('brief_write', req.org.id)) return res.status(429).json(rateLimitedBody('brief_write'));
    if (b.status === 'archived') return res.status(409).json({ error: 'BRIEF_ARCHIVED' });
    // A brief is a collaborative record: refuse a write built on a stale read
    // rather than quietly discarding a colleague's edit (M18.1).
    if (!guardRev(req, res, b, {
      errorCode: 'BRIEF_VERSION_CONFLICT',
      current: { currentVersion: b.version, status: b.status, updatedAt: b.updatedAt, updatedBy: b.revBy?.name ?? null },
    })) return;

    // Everything is checked before anything is written.
    let statusTo = null;
    if (req.body?.status !== undefined) {
      const to = String(req.body.status);
      if (!BRIEF_STATUSES.includes(to)) return res.status(400).json({ error: 'BRIEF_STATUS_UNKNOWN' });
      if (!canBriefTransition(b.status, to)) return res.status(409).json({ error: 'BRIEF_TRANSITION_INVALID', from: b.status, to });
      statusTo = to;
    }
    const wantsCriteria = ['title', 'positions', 'minAge', 'maxAge', 'radiusKm', 'maxLevel', 'foot', 'availability', 'evidenceRequirements', 'minTrustBand', 'combineProtocols', 'activeFrom', 'activeUntil']
      .some((k) => req.body?.[k] !== undefined);
    let v = null;
    if (wantsCriteria) {
      const merged = { title: b.title, ...b.criteria, activeFrom: b.activeFrom, activeUntil: b.activeUntil, ...req.body };
      delete merged.status;
      delete merged.positionGroups; // worked out from the positions, never an input
      v = validateRecruitmentBrief(merged, { orgLevel: req.org.level, protocols: ctx.combineProtocolIds?.() ?? null });
      if (!v.ok) return res.status(400).json(v);
    }

    const stored = discovery.briefs.update(b.id, (d) => {
      if (statusTo !== null) {
        const from = d.status;
        d.status = statusTo;
        audit(d, 'org', req.orgUser.id, req.orgUser.name, statusTo === 'active' ? 'recruitment_brief_activated' : 'recruitment_brief_updated', { from, to: statusTo });
      }
      if (v) {
        const changed = JSON.stringify(v.criteria) !== JSON.stringify(d.criteria);
        d.title = v.title;
        d.activeFrom = v.activeFrom;
        d.activeUntil = v.activeUntil;
        if (changed) {
          // A material criteria change is a NEW version. Historical coverage keeps
          // pointing at the version it was computed against.
          d.criteria = v.criteria;
          d.version += 1;
          audit(d, 'org', req.orgUser.id, req.orgUser.name, 'recruitment_brief_updated', { version: d.version, criteriaChanged: true });
        }
      }
      d.updatedAt = now();
      bumpRev(d, { by: req.orgUser, at: d.updatedAt });
    });
    if (statusTo === 'active') vmetric('recruitment_brief_activated');
    res.json({ brief: briefView(stored) });
  });

  // --------------------------------------------------------- nobody missed

  // M18.2: the window rule lives in shared.mjs so its boundaries are testable.
  const briefIsLive = (b) => briefIsLiveOn(b);

  /** The organisation's reviews for this brief, by player: one query per computation, not one per candidate. */
  const reviewsByPlayer = (orgId, briefId) => new Map(dreads.reviews.forBrief(orgId, briefId).map((r) => [r.playerId, r]));

  /**
   * Compute the brief's candidate set. Gates first, always.
   */
  function computeBrief(req, brief) {
    const org = req.org;
    const eligible = [];
    const evaluatedIds = [];
    const candidates = [];
    let scanned = 0;
    const reviewOf = reviewsByPlayer(org.id, brief.id);

    for (const player of players.list({ visibleTo: org }, { limit: LIMITS.maxCandidateScan })) { // S14h: the SQL part of the visibility rule is the query's
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
      const review = reviewOf.get(player.id) ?? null;
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
    const brief = dreads.briefs.forOrgById(briefId, req.org.id);
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

  /** Record what the club did with a candidate: the first action creates the review, later ones update it; the trail grows. */
  const setReview = (req, brief, playerId, patch) => {
    const at = now();
    const by = { userId: req.orgUser.id, name: req.orgUser.name };
    const existing = dreads.reviews.byKey(req.org.id, brief.id, playerId);
    if (!existing) {
      return discovery.reviews.create({
        id: nextId('nmr'), orgId: req.org.id, briefId: brief.id, briefVersion: brief.version,
        playerId, createdAt: at, updatedAt: at, ...patch, history: [{ at, state: patch.state, by }],
      });
    }
    return discovery.reviews.update(existing.id, (d) => {
      Object.assign(d, patch, { updatedAt: at, briefVersion: brief.version });
      d.history.push({ at, state: d.state, by });
    });
  };
  /** Wire shape: the review's own fields, listed. */
  const reviewView = (r) => ({
    id: r.id, orgId: r.orgId, briefId: r.briefId, briefVersion: r.briefVersion, playerId: r.playerId, state: r.state,
    createdAt: r.createdAt, updatedAt: r.updatedAt, reviewedBy: r.reviewedBy, reviewedAt: r.reviewedAt,
    dismissReason: r.dismissReason, dismissedBy: r.dismissedBy, dismissedAt: r.dismissedAt, roomId: r.roomId,
    history: r.history.map((h) => ({ at: h.at, state: h.state, by: h.by })),
  });

  function briefAndPlayer(req, res) {
    const brief = dreads.briefs.forOrgById(String(req.body?.briefId ?? req.params.briefId), req.org.id);
    if (!brief) { res.status(404).json({ error: 'BRIEF_NOT_FOUND' }); return null; }
    const player = findPlayer(String(req.body?.playerId ?? req.params.playerId));
    if (!player || !orgCanSee(req.org, player)) { res.status(403).json({ error: 'NOT_VISIBLE' }); return null; }
    return { brief, player };
  }

  orgRouter.post('/nobody-missed/review', (req, res) => {
    const ctxp = briefAndPlayer(req, res);
    if (!ctxp) return;
    if (limited('nobody_missed_action', req.org.id)) return res.status(429).json(rateLimitedBody('nobody_missed_action'));
    const r = setReview(req, ctxp.brief, ctxp.player.id, {
      state: 'reviewed', reviewedBy: { userId: req.orgUser.id, name: req.orgUser.name }, reviewedAt: now(),
    });
    vmetric('nobody_missed_player_reviewed');
    res.json({ review: reviewView(r), note: 'Reviewing a candidate records nothing on the player’s own record.' });
  });

  orgRouter.post('/nobody-missed/dismiss', (req, res) => {
    const ctxp = briefAndPlayer(req, res);
    if (!ctxp) return;
    if (limited('nobody_missed_action', req.org.id)) return res.status(429).json(rateLimitedBody('nobody_missed_action'));
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
    res.json({ review: reviewView(r), note: 'Dismissed for this brief only. Nothing is written to the player’s record.' });
  });

  /**
   * Add a candidate to a Recruitment Room. Bridges M17's canonical creator, so
   * the room, its visibility check and its uniqueness rule are all M17's.
   */
  orgRouter.post('/nobody-missed/add-to-room', (req, res) => {
    const ctxp = briefAndPlayer(req, res);
    if (!ctxp) return;
    if (limited('nobody_missed_action', req.org.id)) return res.status(429).json(rateLimitedBody('nobody_missed_action'));
    if (!ctx.createRoomForPlayer) return res.status(503).json({ error: 'ROOM_ENGINE_UNAVAILABLE' });
    // One unit: the Room (or the open one it adopts) and the review commit together.
    const { out, r } = unit(() => {
      const created = ctx.createRoomForPlayer({
        req, player: ctxp.player, sourceContext: 'nobody_missed',
        sourceRef: { id: ctxp.brief.id, version: ctxp.brief.version },
      });
      if (!created.ok) return { out: created, r: null };
      return {
        out: created,
        r: setReview(req, ctxp.brief, ctxp.player.id, {
          state: 'added_to_room', roomId: created.roomId,
          reviewedBy: { userId: req.orgUser.id, name: req.orgUser.name }, reviewedAt: now(),
        }),
      };
    });
    if (!out.ok) return res.status(out.status).json(out);
    vmetric('nobody_missed_player_added_to_room');
    // M18.1: a double click adds the candidate ONCE. M17's creator already
    // returns the existing open room rather than making a second one; the
    // response now says so instead of reporting a creation that did not happen.
    res.status(out.existed ? 200 : 201).json({
      review: reviewView(r), roomId: out.roomId, room: out.room, idempotent: !!out.existed,
    });
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
