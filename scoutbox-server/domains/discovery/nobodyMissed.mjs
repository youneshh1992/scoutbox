// Recruitment Briefs and Nobody Missed. A brief is boolean rules only, with no weights or hidden criteria.
//
// Hidden players never enter the candidate set: they are not matched and then concealed, because concealment after
// matching is how side channels are born.
import {
  validateRecruitmentBrief,
  explainBriefCriteria,
  playerMatchesBrief,
  buildNobodyMissedCandidate,
  evaluationCoverageState,
  BRIEF_STATUSES,
  canBriefTransition,
  EVALUATION_COVERAGE_POLICY_VERSION,
  COVERAGE_POLICY,
  EVALUATION_SIGNALS,
  NON_EVALUATION_SIGNALS,
  NOBODY_MISSED_STATES,
  NM_DISMISSAL_REASONS,
  NM_SORTS,
  EVIDENCE_REQUIREMENTS,
  POSITIONS,
  TRUST_BANDS,
  LIMITS,
  clampPage,
  briefIsLiveOn,
} from './shared.mjs';
import { briefCriteriaToCanonical } from './matching/match.mjs';
import { createMatchReads } from './matching/query.mjs';
import { pageOf, sendPageError } from '../platform/paging.mjs';
import { rateLimitedBody, limitCheck } from '../platform/rateLimit.mjs';
import { guardRev, bumpRev, revMeta } from '../platform/concurrency.mjs';
import { now } from '../platform/clock.mjs';

export function registerNobodyMissed(ctx) {
  const {
    players,
    orgRouter,
    nextId,
    findPlayer,
    orgCanSee,
    isLead,
    requireLead,
    audit,
    vmetric,
    suppress,
    discovery,
    unit,
    matchFacts,
  } = ctx;
  if (typeof matchFacts?.query !== 'function')
    throw new TypeError('registerNobodyMissed needs the matchFacts repository');
  const { matchQuery, factsOfRows, readMatchPage, matchOrder, keyOfRow } = createMatchReads({ players, matchFacts });
  const dreads = ctx.discoveryReads;
  if (typeof dreads?.briefs?.forOrg !== 'function' || typeof discovery?.briefs?.create !== 'function')
    throw new TypeError('registerNobodyMissed needs the discovery repository and discoveryReads from the data layer');
  const reads = ctx.recruitmentReads;
  if (typeof reads?.signings?.forPlayer !== 'function')
    throw new TypeError('registerNobodyMissed needs recruitmentReads (signings) from the data layer');

  const limited = limitCheck(ctx.rateLimit);
  const SUPPRESS_MIN = 3;

  /**
   * The players this organisation has evaluated, as SQL over the signals in EVALUATION_SIGNALS (a Room, open or
   * ended, is a case with a room; a deferral counts until it is due). Each line restates a repository read
   * (forOrgPlayer / has / isListedBy / isDeferred); keep the two together when either changes.
   */
  const evaluatedSql = (orgId, at) => ({
    // NULLs are filtered out: one NULL in the set would make every NOT IN unknown, and hide every candidate.
    sql: `p.id IN (SELECT player_id FROM (
      SELECT player_id FROM recruitment_cases WHERE org_id = ? AND (room_status IS NOT NULL OR stage <> 'closed')
      UNION SELECT player_id FROM room_decisions WHERE org_id = ?
      UNION SELECT player_id FROM assessments WHERE org_id = ? AND state <> 'draft'
      UNION SELECT player_id FROM trials WHERE org_id = ?
      UNION SELECT player_id FROM signings WHERE org_id = ?
      UNION SELECT player_id FROM ledger WHERE org_id = ? AND type = 'shortlist'
      UNION SELECT player_id FROM review_later WHERE org_id = ? AND due_at > ?
      UNION SELECT player_id FROM org_squad_members WHERE org_id = ?
      UNION SELECT player_id FROM org_shadow_players WHERE org_id = ?) WHERE player_id IS NOT NULL)`,
    args: [orgId, orgId, orgId, orgId, orgId, orgId, orgId, at, orgId, orgId],
  });

  // ----------------------------------------------------------------- briefs

  const briefsFor = (orgId) => dreads.briefs.forOrg(orgId);

  function findBrief(req, res) {
    const b = dreads.briefs.forOrgById(String(req.params.id), req.org.id);
    if (!b) {
      res.status(404).json({ error: 'BRIEF_NOT_FOUND' });
      return null;
    }
    return b;
  }

  const briefView = (b) => ({
    id: b.id,
    title: b.title,
    status: b.status,
    version: b.version,
    // `version` is the criteria version historical coverage points at; `rev` moves on every accepted write.
    ...revMeta(b),
    criteria: b.criteria,
    criteriaExplained: explainBriefCriteria(b.criteria),
    activeFrom: b.activeFrom,
    activeUntil: b.activeUntil,
    roleId: b.roleId ?? null,
    vacancyId: b.vacancyId ?? null,
    createdBy: b.createdBy,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    note: 'These are the only criteria used. There are no hidden criteria, no weights and no ranking.',
  });

  orgRouter.get('/recruitment-briefs', (req, res) => {
    // At most LIMITS.briefsPerOrg per organisation, so offset paging is enough.
    const list = briefsFor(req.org.id);
    const limit = clampPage(req.query.limit);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json({
      items: list.slice(offset, offset + limit).map(briefView),
      total: list.length,
      limit,
      offset,
      statuses: BRIEF_STATUSES,
      vocabulary: { positions: POSITIONS, evidenceRequirements: EVIDENCE_REQUIREMENTS, trustBands: TRUST_BANDS },
      policyVersion: EVALUATION_COVERAGE_POLICY_VERSION,
    });
  });

  orgRouter.post('/recruitment-briefs', (req, res) => {
    if (!requireLead(req, res)) return;
    if (limited('brief_write', req.org.id)) return res.status(429).json(rateLimitedBody('brief_write'));
    if (dreads.briefs.countForOrg(req.org.id) >= LIMITS.briefsPerOrg)
      return res.status(409).json({ error: 'BRIEFS_FULL' });
    const v = validateRecruitmentBrief(req.body ?? {}, {
      orgLevel: req.org.level,
      protocols: ctx.combineProtocolIds?.() ?? null,
    });
    if (!v.ok) return res.status(400).json(v);
    const refs = {};
    for (const k of ['roleId', 'vacancyId']) {
      const raw = req.body?.[k];
      if (raw === undefined || raw === null || raw === '') {
        refs[k] = null;
        continue;
      }
      if (typeof raw !== 'string' || raw.length > 64)
        return res
          .status(400)
          .json({ error: 'FIELD_INVALID', field: k, message: `${k} must be an id of at most 64 characters.` });
      refs[k] = raw;
    }

    const at = now();
    const b = {
      id: nextId('brf'),
      orgId: req.org.id,
      title: v.title,
      criteria: v.criteria,
      version: 1,
      status: 'draft',
      activeFrom: v.activeFrom,
      activeUntil: v.activeUntil,
      roleId: refs.roleId,
      vacancyId: refs.vacancyId,
      createdBy: { userId: req.orgUser.id, name: req.orgUser.name },
      createdAt: at,
      updatedAt: at,
      history: [],
      rev: 1,
      revAt: at,
      revBy: { userId: req.orgUser.id, name: req.orgUser.name },
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
    if (
      !guardRev(req, res, b, {
        errorCode: 'BRIEF_VERSION_CONFLICT',
        current: {
          currentVersion: b.version,
          status: b.status,
          updatedAt: b.updatedAt,
          updatedBy: b.revBy?.name ?? null,
        },
      })
    )
      return;

    let statusTo = null;
    if (req.body?.status !== undefined) {
      const to = String(req.body.status);
      if (!BRIEF_STATUSES.includes(to)) return res.status(400).json({ error: 'BRIEF_STATUS_UNKNOWN' });
      if (!canBriefTransition(b.status, to))
        return res.status(409).json({ error: 'BRIEF_TRANSITION_INVALID', from: b.status, to });
      statusTo = to;
    }
    const wantsCriteria = [
      'title',
      'positions',
      'minAge',
      'maxAge',
      'radiusKm',
      'maxLevel',
      'foot',
      'availability',
      'evidenceRequirements',
      'minTrustBand',
      'combineProtocols',
      'activeFrom',
      'activeUntil',
    ].some((k) => req.body?.[k] !== undefined);
    let v = null;
    if (wantsCriteria) {
      const merged = {
        title: b.title,
        ...b.criteria,
        activeFrom: b.activeFrom,
        activeUntil: b.activeUntil,
        ...req.body,
      };
      delete merged.status;
      delete merged.positionGroups; // worked out from the positions, never an input
      v = validateRecruitmentBrief(merged, { orgLevel: req.org.level, protocols: ctx.combineProtocolIds?.() ?? null });
      if (!v.ok) return res.status(400).json(v);
    }

    const stored = discovery.briefs.update(b.id, (d) => {
      if (statusTo !== null) {
        const from = d.status;
        d.status = statusTo;
        audit(
          d,
          'org',
          req.orgUser.id,
          req.orgUser.name,
          statusTo === 'active' ? 'recruitment_brief_activated' : 'recruitment_brief_updated',
          { from, to: statusTo },
        );
      }
      if (v) {
        const changed = JSON.stringify(v.criteria) !== JSON.stringify(d.criteria);
        d.title = v.title;
        d.activeFrom = v.activeFrom;
        d.activeUntil = v.activeUntil;
        if (changed) {
          // Historical coverage keeps pointing at the version it was computed against.
          d.criteria = v.criteria;
          d.version += 1;
          audit(d, 'org', req.orgUser.id, req.orgUser.name, 'recruitment_brief_updated', {
            version: d.version,
            criteriaChanged: true,
          });
        }
      }
      d.updatedAt = now();
      bumpRev(d, { by: req.orgUser, at: d.updatedAt });
    });
    if (statusTo === 'active') vmetric('recruitment_brief_activated');
    res.json({ brief: briefView(stored) });
  });

  // --------------------------------------------------------- nobody missed

  const briefIsLive = (b) => briefIsLiveOn(b);

  const reviewsByPlayer = (orgId, briefId) =>
    new Map(dreads.reviews.forBrief(orgId, briefId).map((r) => [r.playerId, r]));

  /** Every query starts from the players this organisation may see, then applies the brief, then evaluation history. */
  function computeBrief(req, brief, at = now()) {
    const org = req.org;
    const required = briefCriteriaToCanonical(brief.criteria).required;
    const evaluated = evaluatedSql(org.id, at);
    const closed = {
      sql: "p.id IN (SELECT player_id FROM nobody_missed_reviews WHERE org_id = ? AND brief_id = ? AND state IN ('dismissed', 'added_to_room') AND player_id IS NOT NULL)",
      args: [org.id, brief.id],
    };
    const eligible = matchQuery(org, required, at).count();
    // The candidate count is computed only when a caller asks: the coverage does not need it.
    const evaluatedCount = matchQuery(org, required, at, [evaluated]).count();
    return {
      eligible,
      evaluated: evaluatedCount,
      candidateCount: () =>
        eligible -
        matchQuery(org, required, at, [
          { sql: `(${evaluated.sql}) OR (${closed.sql})`, args: [...evaluated.args, ...closed.args] },
        ]).count(),
      candidates: matchQuery(org, required, at, [
        { sql: `NOT (${evaluated.sql})`, args: evaluated.args },
        { sql: `NOT (${closed.sql})`, args: closed.args },
      ]),
      at,
    };
  }

  const nmOrder = (sort, req, brief, at) =>
    matchOrder(sort, req.org, at, {
      last_reviewed: [
        'COALESCE((SELECT nr.reviewed_at FROM nobody_missed_reviews nr WHERE nr.org_id = ? AND nr.brief_id = ? AND nr.player_id = p.id), 0)',
        'ASC',
        [req.org.id, brief.id],
      ],
    });

  orgRouter.get('/nobody-missed', (req, res) => {
    const briefId = String(req.query.briefId ?? '');
    const brief = dreads.briefs.forOrgById(briefId, req.org.id);
    if (!brief) return res.status(404).json({ error: 'BRIEF_NOT_FOUND' });
    if (!briefIsLive(brief)) {
      return res.json({
        brief: briefView(brief),
        live: false,
        items: [],
        total: 0,
        coverage: null,
        note: 'Only an active brief inside its date window produces candidates.',
      });
    }
    const sort = NM_SORTS.includes(String(req.query.sort)) ? String(req.query.sort) : 'newest_evidence';
    const at = now();
    const { order, shape } = nmOrder(sort, req, brief, at);
    let page;
    try {
      page = readMatchPage(req.query, shape);
    } catch (e) {
      return sendPageError(res, e);
    }
    const { eligible, evaluated, candidates, candidateCount } = computeBrief(req, brief, at);
    const coverage = evaluationCoverageState({ eligible, evaluated, suppressMin: SUPPRESS_MIN });
    const { items, nextCursor } = pageOf(candidates.page(order, page), page.limit, keyOfRow);
    const reviewOf = reviewsByPlayer(req.org.id, brief.id);
    const cards = factsOfRows(items, req.org, at)
      .map((facts) => {
        // Explained at the query's own instant, so it is the same test the query applied.
        const card = buildNobodyMissedCandidate({
          facts,
          brief,
          match: playerMatchesBrief(facts, brief.criteria, { now: at }),
          evaluation: { evaluated: false },
          roomOpen: false,
        });
        if (!card) return null;
        const review = reviewOf.get(facts.playerId) ?? null;
        return {
          ...card,
          distanceKm: facts.distanceKm,
          lastEvidenceAt: facts.lastEvidenceAt,
          state: review?.state ?? 'open',
          reviewedAt: review?.reviewedAt ?? null,
        };
      })
      .filter(Boolean);
    res.json({
      brief: briefView(brief),
      live: true,
      briefVersion: brief.version,
      items: cards,
      nextCursor,
      total: candidateCount(),
      limit: page.limit,
      coverage,
      sorts: NM_SORTS,
      sort,
      evaluationPolicy: {
        version: EVALUATION_COVERAGE_POLICY_VERSION,
        counts: EVALUATION_SIGNALS,
        doesNotCount: NON_EVALUATION_SIGNALS,
        recentDecisionDays: COVERAGE_POLICY.recentDecisionDays,
      },
      note: 'Eligible under your own criteria and not yet in your evaluation workflow. This is workflow coverage, not a judgement of any player, and nothing here is ranked by quality.',
    });
  });

  const setReview = (req, brief, playerId, patch) => {
    const at = now();
    const by = { userId: req.orgUser.id, name: req.orgUser.name };
    const existing = dreads.reviews.byKey(req.org.id, brief.id, playerId);
    if (!existing) {
      return discovery.reviews.create({
        id: nextId('nmr'),
        orgId: req.org.id,
        briefId: brief.id,
        briefVersion: brief.version,
        playerId,
        createdAt: at,
        updatedAt: at,
        ...patch,
        history: [{ at, state: patch.state, by }],
      });
    }
    return discovery.reviews.update(existing.id, (d) => {
      Object.assign(d, patch, { updatedAt: at, briefVersion: brief.version });
      d.history.push({ at, state: d.state, by });
    });
  };
  const reviewView = (r) => ({
    id: r.id,
    orgId: r.orgId,
    briefId: r.briefId,
    briefVersion: r.briefVersion,
    playerId: r.playerId,
    state: r.state,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt,
    dismissReason: r.dismissReason,
    dismissedBy: r.dismissedBy,
    dismissedAt: r.dismissedAt,
    roomId: r.roomId,
    history: r.history.map((h) => ({ at: h.at, state: h.state, by: h.by })),
  });

  function briefAndPlayer(req, res) {
    const brief = dreads.briefs.forOrgById(String(req.body?.briefId ?? req.params.briefId), req.org.id);
    if (!brief) {
      res.status(404).json({ error: 'BRIEF_NOT_FOUND' });
      return null;
    }
    const player = findPlayer(String(req.body?.playerId ?? req.params.playerId));
    if (!player || !orgCanSee(req.org, player)) {
      res.status(403).json({ error: 'NOT_VISIBLE' });
      return null;
    }
    return { brief, player };
  }

  orgRouter.post('/nobody-missed/review', (req, res) => {
    const ctxp = briefAndPlayer(req, res);
    if (!ctxp) return;
    if (limited('nobody_missed_action', req.org.id))
      return res.status(429).json(rateLimitedBody('nobody_missed_action'));
    const r = setReview(req, ctxp.brief, ctxp.player.id, {
      state: 'reviewed',
      reviewedBy: { userId: req.orgUser.id, name: req.orgUser.name },
      reviewedAt: now(),
    });
    vmetric('nobody_missed_player_reviewed');
    res.json({ review: reviewView(r), note: 'Reviewing a candidate records nothing on the player’s own record.' });
  });

  orgRouter.post('/nobody-missed/dismiss', (req, res) => {
    const ctxp = briefAndPlayer(req, res);
    if (!ctxp) return;
    if (limited('nobody_missed_action', req.org.id))
      return res.status(429).json(rateLimitedBody('nobody_missed_action'));
    const reason = req.body?.reason ?? null;
    if (reason != null && !NM_DISMISSAL_REASONS.includes(reason)) {
      return res.status(400).json({ error: 'NM_REASON_UNKNOWN', allowed: NM_DISMISSAL_REASONS });
    }
    const r = setReview(req, ctxp.brief, ctxp.player.id, {
      state: 'dismissed',
      dismissReason: reason,
      dismissedBy: { userId: req.orgUser.id, name: req.orgUser.name },
      dismissedAt: now(),
    });
    vmetric('nobody_missed_player_dismissed');
    res.json({
      review: reviewView(r),
      note: 'Dismissed for this brief only. Nothing is written to the player’s record.',
    });
  });

  orgRouter.post('/nobody-missed/add-to-room', (req, res) => {
    const ctxp = briefAndPlayer(req, res);
    if (!ctxp) return;
    if (limited('nobody_missed_action', req.org.id))
      return res.status(429).json(rateLimitedBody('nobody_missed_action'));
    if (!ctx.createRoomForPlayer) return res.status(503).json({ error: 'ROOM_ENGINE_UNAVAILABLE' });
    const { out, r } = unit(() => {
      const created = ctx.createRoomForPlayer({
        req,
        player: ctxp.player,
        sourceContext: 'nobody_missed',
        sourceRef: { id: ctxp.brief.id, version: ctxp.brief.version },
      });
      if (!created.ok) return { out: created, r: null };
      return {
        out: created,
        r: setReview(req, ctxp.brief, ctxp.player.id, {
          state: 'added_to_room',
          roomId: created.roomId,
          reviewedBy: { userId: req.orgUser.id, name: req.orgUser.name },
          reviewedAt: now(),
        }),
      };
    });
    if (!out.ok) return res.status(out.status).json(out);
    vmetric('nobody_missed_player_added_to_room');
    // A double click adds the candidate once: the rooms' creator returns the existing open room.
    res.status(out.existed ? 200 : 201).json({
      review: reviewView(r),
      roomId: out.roomId,
      room: out.room,
      idempotent: !!out.existed,
    });
  });

  orgRouter.get('/evaluation-coverage', (req, res) => {
    const items = briefsFor(req.org.id)
      .filter(briefIsLive)
      .map((brief) => {
        const { eligible, evaluated } = computeBrief(req, brief);
        return {
          briefId: brief.id,
          title: brief.title,
          briefVersion: brief.version,
          coverage: evaluationCoverageState({ eligible, evaluated, suppressMin: SUPPRESS_MIN }),
        };
      });
    res.json({
      items,
      policyVersion: EVALUATION_COVERAGE_POLICY_VERSION,
      note: COVERAGE_POLICY.note,
    });
  });

  void NOBODY_MISSED_STATES;
  void isLead;
  void suppress;
}
