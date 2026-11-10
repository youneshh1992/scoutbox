/**
 * Matching and Dynamic Watchlists: routes. Matching is the last step: every query starts from the players the
 * organisation may see (identity's `visibleWhere`), so no criterion is ever evaluated against a player the club may
 * not know exists, including through a count.
 */
import {
  validateCriteria, criteriaVersion, describeCriteria, CRITERION_TYPES,
  OPERATORS, LIMITS as MATCHING_LIMITS, MATCH_POLICY_VERSION, CRITERIA_SCHEMA_VERSION,
  AVAILABILITY_VALUES,
} from './criteria.mjs';
import { matchPlayerToCriteria, briefCriteriaToCanonical } from './match.mjs';
import { createMatchReads } from './query.mjs';
import {
  WATCHLIST_MODES, WATCHLIST_STATUSES, WATCHLIST_SOURCES,
  reconcileMembership, transitionFingerprint, explainTransition,
  membershipSummary, membershipNotification, watchlistBlockedState,
} from './watchlists.mjs';
import { guardRev, bumpRev, revMeta } from '../../platform/concurrency.mjs';
import { readPage, pageOf, sendPageError } from '../../platform/paging.mjs';
import { now } from '../../platform/clock.mjs';
import { limitCheck } from '../../platform/rateLimit.mjs';

/** None of these is a match quality rank; the default is the least suggestive one that is still useful. */
export const MATCH_SORTS = ['recent_evidence', 'name', 'age', 'evidence_confidence', 'distance'];
export const DEFAULT_MATCH_SORT = 'recent_evidence';

export function registerMatching(ctx) {
  const {
    players, orgRouter, nextId, findPlayer, orgCanSee,
    isLead, requireLead, audit, vmetric, notify, broadcast, discovery, unit, matchFacts,
  } = ctx;
  if (typeof matchFacts?.query !== 'function' || typeof players?.visibleWhere !== 'function') throw new TypeError('registerMatching needs the matchFacts repository and the players\' visibleWhere');
  const dreads = ctx.discoveryReads;
  if (typeof dreads?.watchlists?.page !== 'function' || typeof discovery?.watchlists?.reconcile !== 'function') throw new TypeError('registerMatching needs the discovery repository and discoveryReads from the data layer');

  const limited = limitCheck(ctx.rateLimit);

  const combineProtocolIds = () => (ctx.combineProtocolIds?.() ?? null);

  const { EMPTY_QUERY, matchQuery, factsOfRows, visibleFactsOf, matchOrder, keyOfRow, readMatchPage } = createMatchReads({ players, matchFacts });

  function resolveCriteria(req, body) {
    if (body?.briefId) {
      const brief = dreads.briefs.forOrgById(String(body.briefId), req.org.id);
      // Another organisation's brief does not exist, rather than being forbidden: anything else is a membership oracle.
      if (!brief) return { ok: false, status: 404, body: { error: 'BRIEF_NOT_FOUND' } };
      return { ok: true, criteria: briefCriteriaToCanonical(brief.criteria), brief };
    }
    const v = validateCriteria(body?.criteria ?? {}, {
      orgLevel: req.org.level ?? 'pro',
      protocols: combineProtocolIds(),
    });
    if (!v.ok) return { ok: false, status: 400, body: v };
    return { ok: true, criteria: v.criteria, brief: null };
  }

  function matchView(facts, result, org) {
    return {
      playerId: facts.playerId,
      name: facts.name,
      position: facts.position,
      secondaryPositions: facts.secondaryPositions ?? [],
      age: facts.age,
      trustBand: facts.trustBand,
      trustNote: 'Evidence confidence — not football ability.',
      distanceKm: org.level === 'grassroots' ? facts.distanceKm ?? null : null,
      required: result.required.map(({ criterionId, met, text }) => ({ criterionId, met, text })),
      preferred: result.preferred.map(({ criterionId, met, text }) => ({ criterionId, met, text })),
      preferredMet: result.preferredMet,
      preferredTotal: result.preferredTotal,
      policyVersion: result.policyVersion,
      note: 'Matches the criteria your organisation wrote. ScoutBox does not rank or score these players.',
    };
  }

  // ------------------------------------------------------------- vocabulary

  orgRouter.get('/matching/vocabulary', (req, res) => {
    res.json({
      criterionTypes: Object.entries(CRITERION_TYPES).map(([type, d]) => ({ type, label: d.label, operators: d.operators })),
      operators: Object.entries(OPERATORS).map(([id, o]) => ({ id, ...o })),
      sorts: MATCH_SORTS,
      defaultSort: DEFAULT_MATCH_SORT,
      limits: MATCHING_LIMITS,
      policyVersion: MATCH_POLICY_VERSION,
      schemaVersion: CRITERIA_SCHEMA_VERSION,
      combineProtocols: combineProtocolIds() ?? [],
      // Suggestions, not a whitelist.
      availabilityValues: AVAILABILITY_VALUES,
      note: 'Every criterion is a fact test your club writes. There is no hidden criterion, no weighting and no overall match score.',
    });
  });

  // ---------------------------------------------------------------- matching

  orgRouter.post('/matching', (req, res) => {
    if (limited('matching_query', req.org.id)) return res.status(429).json({ error: 'RATE_LIMITED', action: 'matching_query' });
    const resolved = resolveCriteria(req, req.body);
    if (!resolved.ok) return res.status(resolved.status).json(resolved.body);

    const sort = MATCH_SORTS.includes(req.body?.sort) ? req.body.sort : DEFAULT_MATCH_SORT;
    if (sort === 'distance' && (req.org.level ?? 'pro') !== 'grassroots') {
      return res.status(400).json({ error: 'SORT_NOT_AVAILABLE', message: 'Distance ordering is only available where your organisation is authorised to see distance.' });
    }
    const at = now();
    const { order, shape } = matchOrder(sort, req.org, at);
    let page;
    try { page = readMatchPage(req.body, shape); } catch (e) { return sendPageError(res, e); }

    const query = matchQuery(req.org, resolved.criteria.required, at);
    const { items, nextCursor } = pageOf(query.page(order, page), page.limit, keyOfRow);
    const total = query.count();

    vmetric?.('matching_query_run');
    res.set('X-ScoutBox-Ordering', `${sort},player_id`);
    res.json({
      items: factsOfRows(items, req.org, at).map((facts) => matchView(facts, matchPlayerToCriteria(facts, resolved.criteria, { now: at }), req.org)),
      // Over visible matches only: a "considered" figure would reveal players this club cannot see.
      total,
      nextCursor,
      limit: page.limit,
      sort,
      ordering: `${sort},player_id`,
      criteria: describeCriteria(resolved.criteria),
      criteriaVersion: criteriaVersion(resolved.criteria),
      policyVersion: MATCH_POLICY_VERSION,
      briefId: resolved.brief?.id ?? null,
      evaluatedAt: at,
      truncated: false,
      note: 'Every player your organisation can currently see was evaluated against these criteria.',
      scoreNote: 'There is no match score. Required criteria decide the set; preferred criteria are counted, not scored.',
    });
  });

  // -------------------------------------------------------------- watchlists

  const wlView = (w, extra = {}) => ({
    id: w.id,
    name: w.name,
    mode: w.mode,
    status: w.status,
    sourceType: w.sourceType,
    sourceId: w.sourceId ?? null,
    criteria: describeCriteria(effectiveCriteria(w).criteria ?? { required: [], preferred: [] }),
    criteriaVersion: w.criteriaVersion,
    schemaVersion: w.schemaVersion,
    policyVersion: MATCH_POLICY_VERSION,
    notify: w.notify !== false,
    createdBy: w.createdByName ?? null,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    lastReconciledAt: w.lastReconciledAt ?? null,
    ...revMeta(w),
    ...extra,
  });

  function effectiveCriteria(w) {
    if (w.mode === 'live_linked' && w.sourceType === 'brief') {
      const brief = dreads.briefs.forOrgById(w.sourceId, w.orgId);
      if (!brief) return { criteria: null, brief: null };
      return { criteria: briefCriteriaToCanonical(brief.criteria), brief };
    }
    return { criteria: w.criteria, brief: null };
  }

  orgRouter.get('/watchlists', (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    if (status !== null && !WATCHLIST_STATUSES.includes(status)) return res.status(400).json({ error: 'WATCHLIST_STATUS_UNKNOWN', statuses: WATCHLIST_STATUSES });
    // Archived watchlists accumulate, so the list pages.
    let page;
    try { page = readPage(req.query, ['number', 'string']); } catch (e) { return sendPageError(res, e); }
    const { rows, total } = dreads.watchlists.page(req.org.id, { status, after: page.after, limit: page.limit });
    const { items, nextCursor } = pageOf(rows, page.limit, (w) => [w.updatedAt, w.id]);
    res.json({
      items: items.map((w) => wlView(w)),
      nextCursor,
      total,
      modes: WATCHLIST_MODES,
      statuses: WATCHLIST_STATUSES,
      note: 'A Dynamic Watchlist is saved criteria. Membership is derived when it is read.',
    });
  });

  orgRouter.post('/watchlists', (req, res) => {
    if (limited('watchlist_write', req.org.id)) return res.status(429).json({ error: 'RATE_LIMITED', action: 'watchlist_write' });
    if (req.body?.name != null && typeof req.body.name !== 'string') return res.status(400).json({ error: 'FIELD_INVALID', field: 'name', message: 'The name must be text.' });
    const name = String(req.body?.name ?? '').trim().slice(0, MATCHING_LIMITS.maxNameLength);
    if (!name) return res.status(400).json({ error: 'WATCHLIST_NAME_REQUIRED', message: 'Give this watchlist a name your colleagues will recognise.' });
    if (dreads.watchlists.openCount(req.org.id) >= MATCHING_LIMITS.watchlistsPerOrg) {
      return res.status(409).json({ error: 'WATCHLIST_LIMIT_REACHED', limit: MATCHING_LIMITS.watchlistsPerOrg, message: 'Archive a watchlist before creating another.' });
    }
    const mode = WATCHLIST_MODES.includes(req.body?.mode) ? req.body.mode : null;
    if (!mode) return res.status(400).json({ error: 'WATCHLIST_MODE_REQUIRED', modes: WATCHLIST_MODES, message: 'Choose whether this watchlist follows the Recruitment Brief or keeps its own saved criteria.' });
    if (req.body?.sourceType != null && !WATCHLIST_SOURCES.includes(req.body.sourceType)) return res.status(400).json({ error: 'WATCHLIST_SOURCE_UNKNOWN', sources: WATCHLIST_SOURCES });
    if (req.body?.notify != null && typeof req.body.notify !== 'boolean') return res.status(400).json({ error: 'FIELD_INVALID', field: 'notify', message: 'notify must be true or false.' });

    const sourceType = req.body?.sourceType ?? (req.body?.briefId ? 'brief' : 'criteria');
    let sourceId = null;
    let criteria = null;

    if (sourceType === 'brief') {
      const brief = dreads.briefs.forOrgById(String(req.body?.briefId ?? ''), req.org.id);
      if (!brief) return res.status(404).json({ error: 'BRIEF_NOT_FOUND' });
      sourceId = brief.id;
      // Stored even when live-linked, so the history stays readable if the brief is later archived.
      criteria = briefCriteriaToCanonical(brief.criteria);
    } else {
      if (mode === 'live_linked') return res.status(400).json({ error: 'WATCHLIST_MODE_INVALID', message: 'Only a watchlist linked to a Recruitment Brief can follow it live.' });
      const v = validateCriteria(req.body?.criteria ?? {}, { orgLevel: req.org.level ?? 'pro', protocols: combineProtocolIds() });
      if (!v.ok) return res.status(400).json(v);
      if (!v.criteria.required.length) return res.status(400).json({ error: 'CRITERIA_REQUIRED_EMPTY', message: 'A watchlist needs at least one required criterion, or it would match everyone your club can see.' });
      criteria = v.criteria;
      const ref = req.body?.sourceId;
      if (ref != null && ref !== '' && (typeof ref !== 'string' || ref.length > 64)) return res.status(400).json({ error: 'FIELD_INVALID', field: 'sourceId', message: 'sourceId must be a reference of at most 64 characters.' });
      sourceId = ref ? ref : null;
    }

    const at = now();
    const w = {
      id: nextId('wl'),
      orgId: req.org.id,
      name,
      mode,
      status: 'active',
      sourceType,
      sourceId,
      criteria,
      criteriaVersion: criteriaVersion(criteria),
      schemaVersion: CRITERIA_SCHEMA_VERSION,
      notify: req.body?.notify ?? true,
      createdBy: req.orgUser.id,
      // The organisation owns the list: if the creator leaves, it stays and keeps their name.
      createdByName: req.orgUser.name,
      createdAt: at,
      updatedAt: at,
      rev: 1,
      lastCriteriaVersion: null,
      lastReconciledAt: null,
      lastBriefVersion: null,
      history: [],
    };
    audit?.(w, 'org', req.orgUser.id, req.orgUser.name, 'watchlist_created', { mode: w.mode, sourceType: w.sourceType });
    const stored = discovery.watchlists.create(w);
    broadcast?.('watchlist_created', { orgId: req.org.id, watchlistId: stored.id });
    vmetric?.('watchlist_created');
    res.status(201).json({ watchlist: wlView(stored) });
  });

  const findWatchlist = (req, res) => {
    const w = dreads.watchlists.forOrgById(String(req.params.id), req.org.id);
    if (!w) { res.status(404).json({ error: 'WATCHLIST_NOT_FOUND' }); return null; }
    return w;
  };

  /** Runs when somebody reads the watchlist; there is no timer. */
  function reconcile(req, w, { record = true } = {}) {
    const { criteria, brief } = effectiveCriteria(w);
    const blocked = watchlistBlockedState({ status: w.status, mode: w.mode, brief });
    if (!criteria || blocked.blocked) {
      return { blocked, query: EMPTY_QUERY, total: 0, at: now(), summary: membershipSummary({}), criteria: criteria ?? { required: [], preferred: [] } };
    }

    // Facts are decoded only for leavers still visible, to name the criterion they no longer meet.
    const at = now();
    const query = matchQuery(req.org, criteria.required, at);
    const current = query.ids();

    const cv = criteriaVersion(criteria);
    const briefVersion = brief?.version ?? null;
    // Null before the first reconciliation.
    const last = dreads.watchlists.membership(w.id);
    const criteriaChanged = last != null && w.lastCriteriaVersion != null && w.lastCriteriaVersion !== cv;
    const briefChanged = last != null && briefVersion != null && w.lastBriefVersion != null && w.lastBriefVersion !== briefVersion;

    const previous = last?.playerIds ?? null;
    const previousMatch = (playerId) => (last?.required.has(playerId) ? { required: last.required.get(playerId) } : null);
    const first = previous == null;
    const diff = reconcileMembership(previous ?? [], current);
    const currentById = new Map(visibleFactsOf(req.org, diff.left, at).map((facts) => [facts.playerId, { result: matchPlayerToCriteria(facts, criteria, { now: at }) }]));

    if (record && w.status !== 'archived') {
      const events = [];
      for (const playerId of diff.entered) {
        const reason = first
          ? { reason: 'first_evaluation', criterionId: null, text: 'First time this watchlist was evaluated' }
          : explainTransition({
            previousMatch: previousMatch(playerId),
            currentMatch: currentById.get(playerId)?.result ?? null,
            criteriaChanged, briefChanged, transition: 'entered',
          });
        events.push({ playerId, transition: 'entered', ...reason });
      }
      for (const playerId of diff.left) {
        const reason = explainTransition({
          previousMatch: previousMatch(playerId),
          currentMatch: currentById.get(playerId)?.result ?? null,
          criteriaChanged, briefChanged, transition: 'left',
        });
        events.push({ playerId, transition: 'left', ...reason });
      }
      // Only the required met flags are kept: enough to name the criterion that flipped next time, without storing a
      // player record that would go stale or leak. A member met every required criterion, so all are true.
      const members = current.map((playerId) => ({ playerId, required: criteria.required.map((c) => ({ criterionId: c.id, met: true })) }));
      unit(() => {
        const appended = discovery.watchlists.reconcile(w.id, {
          at, criteriaVersion: cv, briefVersion, members,
          events: events.map((e) => ({
            id: nextId('wlh'), watchlistId: w.id, orgId: w.orgId, playerId: e.playerId, transition: e.transition,
            reason: e.reason, criterionId: e.criterionId, text: e.text, criteriaVersion: cv, briefVersion,
            policyVersion: MATCH_POLICY_VERSION, at,
            fingerprint: transitionFingerprint({ watchlistId: w.id, playerId: e.playerId, criteriaVersion: cv, transition: e.transition, reason: e.reason }),
          })),
        });
        for (const e of appended) vmetric?.(e.transition === 'entered' ? 'watchlist_player_entered' : 'watchlist_player_left');
        if (events.length && !first) {
          broadcast?.('watchlist_membership_changed', { orgId: w.orgId, watchlistId: w.id });
          if (w.notify !== false && w.status === 'active') {
            const n = membershipNotification({
              watchlistName: w.name,
              entered: diff.entered,
              left: diff.left,
              reason: briefChanged ? 'brief_changed' : (criteriaChanged ? 'criteria_changed' : 'facts_changed'),
            });
            if (n) notify?.({ kind: 'org_user', id: w.createdBy }, 'watchlist', n.text, w.id);
          }
        }
      });
      vmetric?.('watchlist_reconciled');
    }

    return {
      blocked,
      criteria,
      query,
      total: current.length,
      at,
      diff,
      summary: membershipSummary(diff),
      evaluatedAt: at,
      criteriaVersion: cv,
      briefVersion,
    };
  }

  /**
   * Taken from the recorded history, not this read's diff: a diff is consumed by whoever reads first (the client
   * refetches on a colleague's SSE event), so the person who opened the page would be told nothing changed.
   */
  function lastChangeSummary(w, currentCount) {
    const batch = dreads.events.lastBatch(w.id);
    const at = batch[0]?.at ?? 0;
    const entered = batch.filter((h) => h.transition === 'entered').map((h) => h.playerId);
    const left = batch.filter((h) => h.transition === 'left').map((h) => h.playerId);
    return {
      ...membershipSummary({ entered, left, unchanged: [] }),
      current: currentCount,
      changedAt: at || null,
    };
  }

  orgRouter.get('/watchlists/:id', (req, res) => {
    const w = findWatchlist(req, res);
    if (!w) return;
    const sort = MATCH_SORTS.includes(req.query.sort) ? String(req.query.sort) : DEFAULT_MATCH_SORT;
    const { order, shape } = matchOrder(sort, req.org, now());
    let page;
    try { page = readMatchPage(req.query, shape); } catch (e) { return sendPageError(res, e); }
    const r = reconcile(req, w);
    const fresh = dreads.watchlists.byId(w.id) ?? w; // carries the reconciliation clock this read recorded
    const { items, nextCursor } = pageOf(r.query.page(order, page), page.limit, keyOfRow);
    res.set('X-ScoutBox-Ordering', `${sort},player_id`);
    res.json({
      watchlist: wlView(fresh, { blocked: r.blocked }),
      items: factsOfRows(items, req.org, r.at).map((facts) => matchView(facts, matchPlayerToCriteria(facts, r.criteria, { now: r.at }), req.org)),
      nextCursor,
      total: r.total,
      limit: page.limit,
      sort,
      summary: lastChangeSummary(w, r.total),
      evaluatedAt: r.evaluatedAt ?? null,
      refreshNote: 'Membership is derived when this page is read. ScoutBox does not recompute watchlists in the background in this build.',
    });
  });

  orgRouter.patch('/watchlists/:id', (req, res) => {
    const w = findWatchlist(req, res);
    if (!w) return;
    if (limited('watchlist_write', req.org.id)) return res.status(429).json({ error: 'RATE_LIMITED', action: 'watchlist_write' });
    if (!guardRev(req, res, w, {
      errorCode: 'WATCHLIST_VERSION_CONFLICT',
      current: { name: w.name, status: w.status, mode: w.mode },
    })) return;

    const before = { name: w.name, mode: w.mode, status: w.status, criteriaVersion: w.criteriaVersion };
    const set = {};
    if (req.body?.name !== undefined) {
      if (typeof req.body.name !== 'string') return res.status(400).json({ error: 'FIELD_INVALID', field: 'name', message: 'The name must be text.' });
      const name = req.body.name.trim().slice(0, MATCHING_LIMITS.maxNameLength);
      if (!name) return res.status(400).json({ error: 'WATCHLIST_NAME_REQUIRED' });
      set.name = name;
    }
    if (req.body?.status !== undefined) {
      if (!WATCHLIST_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'WATCHLIST_STATUS_UNKNOWN', statuses: WATCHLIST_STATUSES });
      if (w.status === 'archived' && req.body.status !== 'archived') return res.status(409).json({ error: 'WATCHLIST_ARCHIVED', message: 'An archived watchlist keeps its history and is not reopened.' });
      set.status = req.body.status;
    }
    if (req.body?.mode !== undefined) {
      if (!WATCHLIST_MODES.includes(req.body.mode)) return res.status(400).json({ error: 'WATCHLIST_MODE_UNKNOWN', modes: WATCHLIST_MODES });
      if (req.body.mode === 'live_linked' && w.sourceType !== 'brief') return res.status(400).json({ error: 'WATCHLIST_MODE_INVALID', message: 'Only a watchlist linked to a Recruitment Brief can follow it live.' });
      set.mode = req.body.mode;
    }
    if (req.body?.notify !== undefined) {
      if (typeof req.body.notify !== 'boolean') return res.status(400).json({ error: 'FIELD_INVALID', field: 'notify', message: 'notify must be true or false.' });
      set.notify = req.body.notify;
    }
    if (req.body?.criteria !== undefined) {
      if ((set.mode ?? w.mode) === 'live_linked') return res.status(409).json({ error: 'WATCHLIST_LIVE_LINKED', message: 'This watchlist follows its Recruitment Brief. Change the brief, or switch the watchlist to its own saved criteria.' });
      const v = validateCriteria(req.body.criteria, { orgLevel: req.org.level ?? 'pro', protocols: combineProtocolIds() });
      if (!v.ok) return res.status(400).json(v);
      if (!v.criteria.required.length) return res.status(400).json({ error: 'CRITERIA_REQUIRED_EMPTY', message: 'A watchlist needs at least one required criterion.' });
      set.criteria = v.criteria;
      set.criteriaVersion = criteriaVersion(v.criteria);
    }
    const stored = discovery.watchlists.update(w.id, (d) => {
      Object.assign(d, set);
      d.updatedAt = now();
      bumpRev(d, { by: { id: req.orgUser.id, name: req.orgUser.name }, at: d.updatedAt });
      const changed = Object.entries(before).filter(([k, v]) => d[k] !== v).map(([k]) => k);
      audit?.(d, 'org', req.orgUser.id, req.orgUser.name,
        d.status === 'archived' && before.status !== 'archived' ? 'watchlist_archived' : 'watchlist_updated',
        { changed, mode: d.mode, status: d.status });
    });
    broadcast?.('watchlist_updated', { orgId: req.org.id, watchlistId: stored.id });
    if (stored.status === 'archived') broadcast?.('watchlist_archived', { orgId: req.org.id, watchlistId: stored.id });
    res.json({ watchlist: wlView(stored) });
  });

  orgRouter.get('/watchlists/:id/history', (req, res) => {
    const w = findWatchlist(req, res);
    if (!w) return;
    let req2;
    try { req2 = readPage(req.query, ['number', 'string']); } catch (e) {
      if (e?.code === 'PAGE_CURSOR_INVALID') return res.status(400).json({ error: 'HISTORY_CURSOR_INVALID', message: 'That page no longer exists — start again from the first page.' });
      return sendPageError(res, e);
    }
    const { rows, total } = dreads.events.page(w.id, { after: req2.after, limit: req2.limit });
    const { items: page, nextCursor } = pageOf(rows, req2.limit, (h) => [h.at, h.id]);
    res.json({
      items: page.map((h) => {
        const p = findPlayer(h.playerId);
        // A player who has since become invisible keeps the transition, but not their name or id.
        const visible = p && orgCanSee(req.org, p);
        return {
          id: h.id,
          at: h.at,
          transition: h.transition,
          reason: h.reason,
          text: h.text,
          criterionId: h.criterionId,
          criteriaVersion: h.criteriaVersion,
          briefVersion: h.briefVersion,
          playerId: visible ? h.playerId : null,
          playerName: visible ? p.name : null,
        };
      }),
      nextCursor,
      total,
      note: 'Why membership changed, in the club’s own criteria. Entering a watchlist is not an improvement in a player.',
    });
  });

  orgRouter.post('/watchlists/:id/room', (req, res) => {
    const w = findWatchlist(req, res);
    if (!w) return;
    const player = findPlayer(String(req.body?.playerId ?? ''));
    if (!player) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, player)) return res.status(403).json({ error: 'NOT_VISIBLE', message: 'This player is not visible to your organisation under the standing rules.' });

    const created = ctx.createRoomForPlayer?.({ req, player, sourceContext: 'dynamic_watchlist', sourceRef: { id: w.id } });
    if (!created) return res.status(500).json({ error: 'ROOM_BRIDGE_UNAVAILABLE' });
    if (!created.ok) return res.status(created.status ?? 409).json({ error: created.error });
    vmetric?.('watchlist_player_to_room');
    // Re-adding a player who already has a Room is idempotent and is not an event.
    if (!created.existed) broadcast?.('matching_room_created', { orgId: req.org.id, roomId: created.roomId });
    res.status(created.existed ? 200 : 201).json({
      roomId: created.roomId,
      existed: created.existed,
      room: created.room,
      note: 'A Recruitment Room was opened. This player stays on the watchlist while they still match your criteria.',
    });
  });

  void isLead; void requireLead;
}
