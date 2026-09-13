/**
 * M19 — Explainable Matching and Dynamic Watchlists: routes.
 *
 * The order below is the whole security design and it is not negotiable:
 *
 *   organisation standing → authorization → visibility → blocks →
 *   minor/guardian/agency → grassroots radius → candidate facts → matching
 *
 * Matching is the LAST step. It reads `matchFacts`, which is built from
 * `playerViewForOrg` and returns null the moment the organisation may not see
 * the player. No route here touches `db.players` for anything else, so there
 * is no path by which a criterion can be evaluated against a player the club
 * is not allowed to know exists — including through a count (§24).
 */
import {
  validateCriteria, criteriaVersion, describeCriteria, CRITERION_TYPES,
  OPERATORS, LIMITS as M19_LIMITS, MATCH_POLICY_VERSION, CRITERIA_SCHEMA_VERSION,
  AVAILABILITY_VALUES,
} from './criteria.mjs';
import { matchPlayerToCriteria, briefCriteriaToCanonical } from './match.mjs';
import {
  WATCHLIST_MODES, WATCHLIST_STATUSES, WATCHLIST_SOURCES,
  reconcileMembership, transitionFingerprint, explainTransition,
  membershipSummary, membershipNotification, watchlistBlockedState,
} from './watchlists.mjs';
import { LIMITS, clampPage } from '../m18/shared.mjs';
import { guardRev, bumpRev, revMeta } from '../m181/concurrency.mjs';

/** Every ordering M19 offers. None of them is a match quality rank, and the
 *  default is deliberately the least suggestive thing that is still useful. */
export const MATCH_SORTS = ['recent_evidence', 'name', 'age', 'evidence_confidence', 'distance'];
export const DEFAULT_MATCH_SORT = 'recent_evidence';

export function registerMatching(ctx) {
  const {
    db, orgRouter, nextId, persistNow, findPlayer, orgCanSee,
    isLead, requireLead, audit, vmetric, notify, broadcast,
  } = ctx;

  const now = () => Date.now();
  const limited = (action, keyPart) => !!ctx.rateLimit?.limited(action, keyPart);
  db.dynamicWatchlists ??= [];
  db.watchlistHistory ??= [];

  const combineProtocolIds = () => (ctx.combineProtocolIds?.() ?? null);

  // ------------------------------------------------------ candidate universe

  /**
   * The visible candidate universe, in the mandated order. Returns the facts
   * projection for every player this organisation may currently see — and
   * nothing about anyone else, not even a count.
   */
  function visibleCandidates(req) {
    const org = req.org;
    const out = [];
    let scanned = 0;
    let truncated = false;
    for (const player of db.players) {
      if (++scanned > LIMITS.maxCandidateScan) { truncated = true; break; }
      if (!orgCanSee(org, player)) continue;              // standing, blocks, minors, level
      const facts = ctx.m18MatchFacts?.(player, org);      // the SAME projection Nobody Missed uses
      if (!facts) continue;                                // visibility said no
      out.push(facts);
    }
    return { candidates: out, truncated };
  }

  /** Resolve the criteria a request is asking about: a brief, or an explicit
   *  set. A brief's criteria are all required — that is what a brief means. */
  function resolveCriteria(req, body) {
    if (body?.briefId) {
      const brief = (db.recruitmentBriefs ?? []).find((b) => b.id === String(body.briefId) && b.orgId === req.org.id);
      // A brief from another organisation is not "forbidden", it does not
      // exist. Anything else is a membership oracle.
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

  /** Deterministic ordering. Every comparator ends on the player id so two
   *  reads of the same data return the same order (M18.2 rule). */
  function orderMatches(rows, sort) {
    const by = {
      recent_evidence: (a, b) => (b.facts.lastEvidenceAt ?? 0) - (a.facts.lastEvidenceAt ?? 0),
      name: (a, b) => String(a.facts.name ?? '').localeCompare(String(b.facts.name ?? '')),
      age: (a, b) => (a.facts.age ?? 999) - (b.facts.age ?? 999),
      evidence_confidence: (a, b) => bandIndex(b.facts.trustBand) - bandIndex(a.facts.trustBand),
      distance: (a, b) => (a.facts.distanceKm ?? 1e9) - (b.facts.distanceKm ?? 1e9),
    }[sort] ?? by_recent;
    return rows.slice().sort((a, b) => by(a, b) || String(a.facts.playerId).localeCompare(String(b.facts.playerId)));
  }
  function by_recent(a, b) { return (b.facts.lastEvidenceAt ?? 0) - (a.facts.lastEvidenceAt ?? 0); }
  const BANDS = ['limited_evidence', 'developing_evidence', 'established_evidence', 'strong_evidence', 'very_strong_evidence'];
  const bandIndex = (b) => BANDS.indexOf(b);

  /** One match card. Only fields this organisation could already read. */
  function matchView(facts, result, org) {
    return {
      playerId: facts.playerId,
      name: facts.name,
      position: facts.position,
      secondaryPositions: facts.secondaryPositions ?? [],
      age: facts.age,
      trustBand: facts.trustBand,
      trustNote: 'Evidence confidence — not football ability.',
      // Distance is shown only where this organisation is already authorised
      // to see it; the match explanation itself never carries a number.
      distanceKm: org.level === 'grassroots' ? facts.distanceKm ?? null : null,
      required: result.required.map(({ criterionId, met, text }) => ({ criterionId, met, text })),
      preferred: result.preferred.map(({ criterionId, met, text }) => ({ criterionId, met, text })),
      preferredMet: result.preferredMet,
      preferredTotal: result.preferredTotal,
      policyVersion: result.policyVersion,
      note: 'Matches the criteria your organisation wrote. ScoutBox does not rank or score these players.',
    };
  }

  /**
   * Run the criteria over the visible universe. Returns matches only:
   * a non-match is simply absent, and no field of theirs is assembled (§22).
   */
  function runMatching(req, criteria) {
    const { candidates, truncated } = visibleCandidates(req);
    const at = now();
    const rows = [];
    for (const facts of candidates) {
      const result = matchPlayerToCriteria(facts, criteria, { now: at });
      if (!result.matchesRequired) continue;
      rows.push({ facts, result });
    }
    return { rows, truncated, evaluatedAt: at, consideredVisible: candidates.length };
  }

  // ------------------------------------------------------------- vocabulary

  orgRouter.get('/matching/vocabulary', (req, res) => {
    res.json({
      criterionTypes: Object.entries(CRITERION_TYPES).map(([type, d]) => ({ type, label: d.label, operators: d.operators })),
      operators: Object.entries(OPERATORS).map(([id, o]) => ({ id, ...o })),
      sorts: MATCH_SORTS,
      defaultSort: DEFAULT_MATCH_SORT,
      limits: M19_LIMITS,
      policyVersion: MATCH_POLICY_VERSION,
      schemaVersion: CRITERIA_SCHEMA_VERSION,
      combineProtocols: combineProtocolIds() ?? [],
      // Suggestions, not a whitelist: the availability criterion still accepts
      // any value, and this only stops a club guessing a spelling.
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
    // Distance ordering is only meaningful where distance is authorised.
    if (sort === 'distance' && (req.org.level ?? 'pro') !== 'grassroots') {
      return res.status(400).json({ error: 'SORT_NOT_AVAILABLE', message: 'Distance ordering is only available where your organisation is authorised to see distance.' });
    }
    const limit = clampPage(req.body?.limit);
    const offset = Math.max(0, Number(req.body?.offset) || 0);

    const { rows, truncated, evaluatedAt, consideredVisible } = runMatching(req, resolved.criteria);
    const ordered = orderMatches(rows, sort);
    const page = ordered.slice(offset, offset + limit);

    vmetric?.('matching_query_run');
    res.set('X-ScoutBox-Ordering', `${sort},player_id`);
    res.json({
      items: page.map(({ facts, result }) => matchView(facts, result, req.org)),
      // The total is over VISIBLE matches. There is deliberately no
      // "considered" figure that would reveal players this club cannot see.
      total: ordered.length,
      offset,
      limit,
      sort,
      ordering: `${sort},player_id`,
      criteria: describeCriteria(resolved.criteria),
      criteriaVersion: criteriaVersion(resolved.criteria),
      policyVersion: MATCH_POLICY_VERSION,
      briefId: resolved.brief?.id ?? null,
      evaluatedAt,
      truncated,
      note: truncated
        ? `Only the first ${LIMITS.maxCandidateScan} visible candidates were evaluated in this request.`
        : 'Every player your organisation can currently see was evaluated against these criteria.',
      scoreNote: 'There is no match score. Required criteria decide the set; preferred criteria are counted, not scored.',
      consideredVisibleNote: `${consideredVisible} visible candidates evaluated.`,
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

  /** The criteria a watchlist evaluates right now: its own, or the linked
   *  brief's when it is live-linked. The mode is explicit, never inferred. */
  function effectiveCriteria(w) {
    if (w.mode === 'live_linked' && w.sourceType === 'brief') {
      const brief = (db.recruitmentBriefs ?? []).find((b) => b.id === w.sourceId && b.orgId === w.orgId);
      if (!brief) return { criteria: null, brief: null };
      return { criteria: briefCriteriaToCanonical(brief.criteria), brief };
    }
    return { criteria: w.criteria, brief: null };
  }

  orgRouter.get('/watchlists', (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    const list = db.dynamicWatchlists
      .filter((w) => w.orgId === req.org.id && (!status || w.status === status))
      // Newest activity first, id as the stable tie-break.
      .sort((a, b) => (b.updatedAt - a.updatedAt) || String(a.id).localeCompare(String(b.id)));
    res.json({
      items: list.map((w) => wlView(w)),
      total: list.length,
      modes: WATCHLIST_MODES,
      statuses: WATCHLIST_STATUSES,
      note: 'A Dynamic Watchlist is saved criteria. Membership is derived when it is read.',
    });
  });

  orgRouter.post('/watchlists', (req, res) => {
    if (limited('watchlist_write', req.org.id)) return res.status(429).json({ error: 'RATE_LIMITED', action: 'watchlist_write' });
    const name = String(req.body?.name ?? '').trim().slice(0, M19_LIMITS.maxNameLength);
    if (!name) return res.status(400).json({ error: 'WATCHLIST_NAME_REQUIRED', message: 'Give this watchlist a name your colleagues will recognise.' });
    const mine = db.dynamicWatchlists.filter((w) => w.orgId === req.org.id && w.status !== 'archived');
    if (mine.length >= M19_LIMITS.watchlistsPerOrg) {
      return res.status(409).json({ error: 'WATCHLIST_LIMIT_REACHED', limit: M19_LIMITS.watchlistsPerOrg, message: 'Archive a watchlist before creating another.' });
    }
    const mode = WATCHLIST_MODES.includes(req.body?.mode) ? req.body.mode : null;
    if (!mode) return res.status(400).json({ error: 'WATCHLIST_MODE_REQUIRED', modes: WATCHLIST_MODES, message: 'Choose whether this watchlist follows the Recruitment Brief or keeps its own saved criteria.' });

    const sourceType = WATCHLIST_SOURCES.includes(req.body?.sourceType) ? req.body.sourceType : (req.body?.briefId ? 'brief' : 'criteria');
    let sourceId = null;
    let criteria = null;

    if (sourceType === 'brief') {
      const brief = (db.recruitmentBriefs ?? []).find((b) => b.id === String(req.body?.briefId ?? '') && b.orgId === req.org.id);
      if (!brief) return res.status(404).json({ error: 'BRIEF_NOT_FOUND' });
      sourceId = brief.id;
      // Even a live-linked watchlist stores the criteria it was created from,
      // so its history stays readable if the brief is later archived.
      criteria = briefCriteriaToCanonical(brief.criteria);
    } else {
      if (mode === 'live_linked') return res.status(400).json({ error: 'WATCHLIST_MODE_INVALID', message: 'Only a watchlist linked to a Recruitment Brief can follow it live.' });
      const v = validateCriteria(req.body?.criteria ?? {}, { orgLevel: req.org.level ?? 'pro', protocols: combineProtocolIds() });
      if (!v.ok) return res.status(400).json(v);
      if (!v.criteria.required.length) return res.status(400).json({ error: 'CRITERIA_REQUIRED_EMPTY', message: 'A watchlist needs at least one required criterion, or it would match everyone your club can see.' });
      criteria = v.criteria;
      sourceId = req.body?.sourceId ? String(req.body.sourceId).slice(0, 64) : null;
    }

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
      notify: req.body?.notify !== false,
      createdBy: req.orgUser.id,
      // The person is attributed, but the organisation owns the list: if they
      // leave, the watchlist stays and keeps their name on its creation (§50).
      createdByName: req.orgUser.name,
      createdAt: now(),
      updatedAt: now(),
      rev: 1,
      lastMembership: null,
      lastReconciledAt: null,
      lastBriefVersion: null,
    };
    db.dynamicWatchlists.push(w);
    audit?.(w, 'org', req.orgUser.id, req.orgUser.name, 'watchlist_created', { mode: w.mode, sourceType: w.sourceType });
    broadcast?.('watchlist_created', { orgId: req.org.id, watchlistId: w.id });
    vmetric?.('watchlist_created');
    persistNow();
    res.status(201).json({ watchlist: wlView(w) });
  });

  const findWatchlist = (req, res) => {
    const w = db.dynamicWatchlists.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    // Another organisation's id is a 404, exactly as a nonexistent id is.
    if (!w) { res.status(404).json({ error: 'WATCHLIST_NOT_FOUND' }); return null; }
    return w;
  };

  /**
   * Derive membership now, compare it with the last derivation, record what
   * changed and why. This is the reconciliation the product is honest about:
   * it runs when somebody reads the watchlist, not on a timer that does not
   * exist in this build.
   */
  function reconcile(req, w, { record = true } = {}) {
    const { criteria, brief } = effectiveCriteria(w);
    const blocked = watchlistBlockedState({ status: w.status, mode: w.mode, brief });
    if (!criteria || blocked.blocked) {
      return { blocked, items: [], summary: membershipSummary({}), criteria: criteria ?? { required: [], preferred: [] } };
    }

    const at = now();
    const { candidates } = visibleCandidates(req);
    const rows = [];
    const currentById = new Map();
    for (const facts of candidates) {
      const result = matchPlayerToCriteria(facts, criteria, { now: at });
      currentById.set(facts.playerId, { facts, result });
      if (result.matchesRequired) rows.push({ facts, result });
    }

    const cv = criteriaVersion(criteria);
    const briefVersion = brief?.version ?? null;
    const criteriaChanged = w.lastMembership != null && w.lastCriteriaVersion != null && w.lastCriteriaVersion !== cv;
    const briefChanged = w.lastMembership != null && briefVersion != null && w.lastBriefVersion != null && w.lastBriefVersion !== briefVersion;

    const previous = w.lastMembership ?? null;
    const current = rows.map((r) => r.facts.playerId).sort();
    const first = previous == null;
    const diff = reconcileMembership(previous ?? [], current);

    if (record && w.status !== 'archived') {
      const events = [];
      for (const playerId of diff.entered) {
        const reason = first
          ? { reason: 'first_evaluation', criterionId: null, text: 'First time this watchlist was evaluated' }
          : explainTransition({
            previousMatch: w.lastMatchSnapshot?.[playerId] ?? null,
            currentMatch: currentById.get(playerId)?.result ?? null,
            criteriaChanged, briefChanged, transition: 'entered',
          });
        events.push({ playerId, transition: 'entered', ...reason });
      }
      for (const playerId of diff.left) {
        const reason = explainTransition({
          previousMatch: w.lastMatchSnapshot?.[playerId] ?? null,
          currentMatch: currentById.get(playerId)?.result ?? null,
          criteriaChanged, briefChanged, transition: 'left',
        });
        events.push({ playerId, transition: 'left', ...reason });
      }
      for (const e of events) {
        const fingerprint = transitionFingerprint({ watchlistId: w.id, playerId: e.playerId, criteriaVersion: cv, transition: e.transition, reason: e.reason });
        // The same transition observed twice is one transition.
        if (db.watchlistHistory.some((h) => h.fingerprint === fingerprint)) continue;
        db.watchlistHistory.push({
          id: nextId('wlh'),
          watchlistId: w.id,
          orgId: w.orgId,
          playerId: e.playerId,
          transition: e.transition,
          reason: e.reason,
          criterionId: e.criterionId,
          text: e.text,
          criteriaVersion: cv,
          briefVersion,
          policyVersion: MATCH_POLICY_VERSION,
          at,
          fingerprint,
        });
        vmetric?.(e.transition === 'entered' ? 'watchlist_player_entered' : 'watchlist_player_left');
      }
      if (events.length && !first) {
        broadcast?.('watchlist_membership_changed', { orgId: w.orgId, watchlistId: w.id });
        // One grouped notification per watchlist, and only when the person
        // asked for them: bulk criteria edits must not become a wall of noise.
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
      w.lastMembership = current;
      w.lastCriteriaVersion = cv;
      w.lastBriefVersion = briefVersion;
      // Only the required lines are kept, and only their met flags: enough to
      // name the criterion that flipped next time, without storing a player
      // record that would go stale or leak.
      w.lastMatchSnapshot = Object.fromEntries(rows.map(({ facts, result }) => [
        facts.playerId, { required: result.required.map((r) => ({ criterionId: r.criterionId, met: r.met })) },
      ]));
      w.lastReconciledAt = at;
      vmetric?.('watchlist_reconciled');
      persistNow();
    }

    return {
      blocked,
      criteria,
      items: rows.map(({ facts, result }) => matchView(facts, result, req.org)),
      diff,
      summary: membershipSummary(diff),
      evaluatedAt: at,
      criteriaVersion: cv,
      briefVersion,
    };
  }

  orgRouter.get('/watchlists/:id', (req, res) => {
    const w = findWatchlist(req, res);
    if (!w) return;
    const sort = MATCH_SORTS.includes(req.query.sort) ? String(req.query.sort) : DEFAULT_MATCH_SORT;
    const r = reconcile(req, w);
    const ordered = r.items.slice().sort((a, b) => {
      const cmp = {
        recent_evidence: () => 0,
        name: () => String(a.name ?? '').localeCompare(String(b.name ?? '')),
        age: () => (a.age ?? 999) - (b.age ?? 999),
        evidence_confidence: () => bandIndex(b.trustBand) - bandIndex(a.trustBand),
        distance: () => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9),
      }[sort]?.() ?? 0;
      return cmp || String(a.playerId).localeCompare(String(b.playerId));
    });
    const limit = clampPage(req.query.limit);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.set('X-ScoutBox-Ordering', `${sort},player_id`);
    res.json({
      watchlist: wlView(w, { blocked: r.blocked }),
      items: ordered.slice(offset, offset + limit),
      total: ordered.length,
      offset,
      limit,
      sort,
      summary: r.summary,
      evaluatedAt: r.evaluatedAt ?? null,
      refreshNote: 'Membership is derived when this page is read. ScoutBox does not recompute watchlists in the background in this build.',
    });
  });

  orgRouter.patch('/watchlists/:id', (req, res) => {
    const w = findWatchlist(req, res);
    if (!w) return;
    if (limited('watchlist_write', req.org.id)) return res.status(429).json({ error: 'RATE_LIMITED', action: 'watchlist_write' });
    // The shared M18.1 concurrency contract: a write built on a stale read is
    // refused and says who moved it, through the same 409 shape as everywhere.
    if (!guardRev(req, res, w, {
      errorCode: 'WATCHLIST_VERSION_CONFLICT',
      current: { name: w.name, status: w.status, mode: w.mode },
    })) return;

    const before = { name: w.name, mode: w.mode, status: w.status, criteriaVersion: w.criteriaVersion };

    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim().slice(0, M19_LIMITS.maxNameLength);
      if (!name) return res.status(400).json({ error: 'WATCHLIST_NAME_REQUIRED' });
      w.name = name;
    }
    if (req.body?.status !== undefined) {
      if (!WATCHLIST_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'WATCHLIST_STATUS_UNKNOWN', statuses: WATCHLIST_STATUSES });
      if (w.status === 'archived' && req.body.status !== 'archived') return res.status(409).json({ error: 'WATCHLIST_ARCHIVED', message: 'An archived watchlist keeps its history and is not reopened.' });
      w.status = req.body.status;
    }
    if (req.body?.mode !== undefined) {
      if (!WATCHLIST_MODES.includes(req.body.mode)) return res.status(400).json({ error: 'WATCHLIST_MODE_UNKNOWN', modes: WATCHLIST_MODES });
      if (req.body.mode === 'live_linked' && w.sourceType !== 'brief') return res.status(400).json({ error: 'WATCHLIST_MODE_INVALID', message: 'Only a watchlist linked to a Recruitment Brief can follow it live.' });
      w.mode = req.body.mode;
    }
    if (req.body?.notify !== undefined) w.notify = req.body.notify !== false;
    if (req.body?.criteria !== undefined) {
      if (w.mode === 'live_linked') return res.status(409).json({ error: 'WATCHLIST_LIVE_LINKED', message: 'This watchlist follows its Recruitment Brief. Change the brief, or switch the watchlist to its own saved criteria.' });
      const v = validateCriteria(req.body.criteria, { orgLevel: req.org.level ?? 'pro', protocols: combineProtocolIds() });
      if (!v.ok) return res.status(400).json(v);
      if (!v.criteria.required.length) return res.status(400).json({ error: 'CRITERIA_REQUIRED_EMPTY', message: 'A watchlist needs at least one required criterion.' });
      w.criteria = v.criteria;
      w.criteriaVersion = criteriaVersion(v.criteria);
    }
    w.updatedAt = now();
    bumpRev(w, { by: { id: req.orgUser.id, name: req.orgUser.name }, at: w.updatedAt });
    const changed = Object.entries(before).filter(([k, v]) => w[k] !== v).map(([k]) => k);
    audit?.(w, 'org', req.orgUser.id, req.orgUser.name,
      w.status === 'archived' && before.status !== 'archived' ? 'watchlist_archived' : 'watchlist_updated',
      { changed, mode: w.mode, status: w.status });
    broadcast?.('watchlist_updated', { orgId: req.org.id, watchlistId: w.id });
    if (w.status === 'archived') broadcast?.('watchlist_archived', { orgId: req.org.id, watchlistId: w.id });
    persistNow();
    res.json({ watchlist: wlView(w) });
  });

  orgRouter.get('/watchlists/:id/history', (req, res) => {
    const w = findWatchlist(req, res);
    if (!w) return;
    const limit = clampPage(req.query.limit);
    const all = db.watchlistHistory
      .filter((h) => h.watchlistId === w.id)
      .sort((a, b) => (b.at - a.at) || String(b.id).localeCompare(String(a.id)));
    let start = 0;
    if (req.query.cursor) {
      const idx = all.findIndex((h) => h.id === String(req.query.cursor));
      if (idx < 0) return res.status(400).json({ error: 'HISTORY_CURSOR_INVALID', message: 'That page no longer exists — start again from the first page.' });
      start = idx + 1;
    }
    const page = all.slice(start, start + limit);
    res.json({
      items: page.map((h) => {
        const p = findPlayer(h.playerId);
        // A player who has since become invisible keeps their transition in
        // the history, but their name does not come back out of it.
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
      nextCursor: start + limit < all.length ? page[page.length - 1]?.id ?? null : null,
      total: all.length,
      note: 'Why membership changed, in the club’s own criteria. Entering a watchlist is not an improvement in a player.',
    });
  });

  /**
   * The Room bridge. It does not create a Room itself: it calls the canonical
   * M17 creator, so every standing gate, the one-open-room rule and the
   * activity trail behave exactly as they do from anywhere else (§70).
   */
  orgRouter.post('/watchlists/:id/room', (req, res) => {
    const w = findWatchlist(req, res);
    if (!w) return;
    const player = findPlayer(String(req.body?.playerId ?? ''));
    if (!player) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!orgCanSee(req.org, player)) return res.status(403).json({ error: 'NOT_VISIBLE', message: 'This player is not visible to your organisation under the standing rules.' });

    const created = ctx.createRoomForPlayer?.({ req, player, sourceContext: 'dynamic_watchlist', sourceRef: w.id });
    if (!created) return res.status(500).json({ error: 'ROOM_BRIDGE_UNAVAILABLE' });
    if (!created.ok) return res.status(created.status ?? 409).json({ error: created.error });
    vmetric?.('watchlist_player_to_room');
    // Only a genuinely new Room is an event; re-adding a player who already
    // has one is idempotent and must not look like a second creation.
    if (!created.existed) broadcast?.('matching_room_created', { orgId: req.org.id, roomId: created.roomId });
    persistNow();
    res.status(created.existed ? 200 : 201).json({
      roomId: created.roomId,
      existed: created.existed,
      room: created.room,
      // A Room and a watchlist answer different questions. The player stays on
      // the list while they still match; being evaluated is not a reason to
      // stop tracking whether they still meet the criteria (§72).
      note: 'A Recruitment Room was opened. This player stays on the watchlist while they still match your criteria.',
    });
  });

  ctx.m19Reconcile = reconcile;
  ctx.m19VisibleCandidates = visibleCandidates;
  void isLead; void requireLead;
}
