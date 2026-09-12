// M18 — Second Look: change collection, workflow state and the org routes.
//
// The engine in shared.mjs decides WHAT counts as a material change and
// whether it relates to the reason a club gave. This file's only jobs are to
// gather the raw facts from canonical stores, persist the workflow state a
// recruiter creates, and serve it back — organisation-private, on the existing
// authenticated router, never to a player.
//
// Two rules govern everything here:
//   1. M18 owns no player truth. It reads canonical stores and stores only
//      workflow: which item a recruiter reviewed, dismissed or acted on.
//   2. M18 never mutates the recruitment pipeline. Reopening a room goes
//      through M17's own reopen path, so there is exactly one transition
//      table, one decision memory and one activity trail.
import { PROVIDERS } from '../m16/drills.mjs';
import {
  SECOND_LOOK_POLICY_VERSION, SECOND_LOOK_STATUSES, canSecondLookTransition,
  DISMISSAL_REASONS, SECOND_LOOK_DISCLAIMER, SECOND_LOOK_KIND_COPY,
  normalizeMaterialChange, changesSinceDecision, buildSecondLookCandidate,
  secondLookStatus, secondLookExpired, orderSecondLook, compareToSnapshot,
  trustLevelChanges, POLICY, LIMITS, clampPage, safeM18Projection,
  CLUB_SIDE_REASONS, REASON_CHANGE_MAP,
} from './shared.mjs';

export function registerSecondLook(ctx) {
  const {
    db, orgRouter, nextId, persistNow, notify, broadcast,
    findPlayer, orgCanSee, isLead, vmetric,
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

  // ------------------------------------------------------ change collection

  /**
   * Gather every canonical fact about this player that changed after `since`,
   * and normalise it. Nothing here copies a source payload — only the change
   * type, the canonical source identity and the clock travel, which is what
   * makes the fingerprint stable across projections.
   */
  function collectChanges(player, org, since) {
    const out = [];
    const add = (type, sourceSystem, sourceId, occurredAt, detail) =>
      out.push(normalizeMaterialChange({ type, subjectId: player.id, sourceSystem, sourceId, occurredAt, detail }));

    // --- M12 evidence ------------------------------------------------------
    for (const e of db.evidence.filter((x) => x.playerId === player.id)) {
      if (e.recordedAt > since && !e.correctionOf) {
        add(e.claimType === 'footage' ? 'full_match_added' : 'evidence_added', 'evidence', e.id, e.recordedAt);
      }
      // A tier upgrade is a real strengthening of the record — but ONLY when it
      // happened after the record was created. Evidence written with a tier at
      // creation time is a new item, not a later confirmation of an old one.
      const reviewedAt = e.verification?.reviewedAt ?? 0;
      if (reviewedAt > since && reviewedAt > (e.recordedAt ?? 0)
        && ['coach_confirmed', 'club_assessed', 'independent'].includes(e.verification?.status)) {
        add('evidence_quality_improved', 'evidence', e.id, reviewedAt);
      }
      // Superseded: the correcting row carries the clock, the original does not.
      if (e.supersededBy) {
        const next = db.evidence.find((x) => x.id === e.supersededBy);
        if (next && next.recordedAt > since) add('evidence_removed', 'evidence', e.id, next.recordedAt);
      }
      for (const d of e.disputes ?? []) {
        if (d.at > since && d.status === 'open') add('evidence_disputed', 'evidence', e.id, d.at);
      }
    }

    // --- M14 verified references ------------------------------------------
    for (const r of db.verReferences ?? []) {
      if (r.playerId !== player.id) continue;
      if (r.status === 'active' && r.createdAt > since) add('verified_reference_added', 'reference', r.id, r.createdAt);
      if (r.withdrawnAt && r.withdrawnAt > since) add('verified_reference_revoked', 'reference', r.id, r.withdrawnAt);
    }

    // --- M16.1 Combine -----------------------------------------------------
    // PRODUCTION ONLY. A result captured through a test-only provider is
    // labelled simulated everywhere else in the product and must never become
    // production recruitment evidence here either.
    for (const a of db.combineAttempts ?? []) {
      if (a.playerId !== player.id) continue;
      if (a.combineState !== 'combine_verified' || !a.completedAt) continue;
      if (PROVIDERS[a.provider]?.testOnly) continue;
      // The live effective state: an invalidated bound session removes it.
      const session = (db.boxSessions ?? []).find((s) => s.id === a.boxSessionId);
      if (session?.verificationState === 'invalidated') continue;
      if (a.completedAt > since) add('combine_verified_added', 'combine', `${a.protocolId}@${a.protocolVersion}`, a.completedAt);
    }

    // --- M16 Box Cam -------------------------------------------------------
    // Never one change per session: that is notification spam, not news. Only
    // the FIRST development evidence since the review, or a completed
    // coach-assigned block, is material.
    const sessions = (db.boxSessions ?? [])
      .filter((s) => s.playerId === player.id && ['verified', 'partially_verified'].includes(s.verificationState) && s.finalizedAt);
    const fresh = sessions.filter((s) => s.finalizedAt > since);
    const hadBefore = sessions.some((s) => s.finalizedAt <= since);
    if (!hadBefore && fresh.length >= POLICY.boxCam.minSessionsForFirstEvidence) {
      const first = fresh.sort((a, b) => a.finalizedAt - b.finalizedAt)[0];
      add('development_evidence_started', 'box_cam', first.id, first.finalizedAt);
    }
    for (const a of db.boxAssignments ?? []) {
      if (a.playerId !== player.id || a.orgId !== org.id) continue;
      if (a.state === 'completed' && a.updatedAt > since) add('development_block_completed', 'box_cam', a.id, a.updatedAt);
    }

    // --- trials, assessments, gap closure ----------------------------------
    for (const t of db.trials ?? []) {
      if (t.playerId !== player.id || t.orgId !== org.id) continue;
      const filedAt = t.report?.filedAt ?? 0;
      if (t.status === 'reported' && filedAt > since) add('trial_completed', 'trial', t.id, filedAt);
    }
    for (const a of db.assessments ?? []) {
      if (a.playerId !== player.id || a.orgId !== org.id) continue;
      if (a.submittedAt && a.submittedAt > since) add('assessment_submitted', 'assessment', a.id, a.submittedAt);
    }
    for (const s of db.evidenceSuggestions ?? []) {
      if (s.playerId !== player.id || s.orgId !== org.id) continue;
      if (s.status === 'supplied' && s.updatedAt > since) add('evidence_gap_closed', 'evidence_gap', s.id, s.updatedAt);
    }

    // --- M18.1: Combine integrity ------------------------------------------
    // Invalidation used to be visible only by ABSENCE — the result quietly
    // stopped being collected and nothing said why. The Box Cam session now
    // keeps an append-only integrity history, so the change is first class and
    // fingerprinted on the SESSION: one invalidation stays one change however
    // many projections (Combine, Passport timeline, Trust) reflect it.
    for (const session of db.boxSessions ?? []) {
      if (session.playerId !== player.id) continue;
      const events = session.integrityEvents ?? [];
      if (!events.length) continue;
      // Only sessions that actually backed a production Combine result matter
      // to a recruitment decision.
      const backed = (db.combineAttempts ?? []).some((a) => a.boxSessionId === session.id
        && a.playerId === player.id && a.combineState === 'combine_verified' && !PROVIDERS[a.provider]?.testOnly);
      if (!backed) continue;
      for (const ev of events) {
        if (!(ev.at > since)) continue;
        if (ev.type === 'invalidated') add('combine_verified_invalidated', 'combine_integrity', session.id, ev.at);
        if (ev.type === 'restored') add('combine_verified_restored', 'combine_integrity', session.id, ev.at);
      }
    }

    // --- M18.1: canonical source changes with their own clocks -------------
    // Position changes and confirmed current clubs were declared change types
    // in M18 that nothing could emit, because the only available timestamps
    // meant something else. These read a real clock or do not fire at all.
    for (const c of ctx.sourceChangesFor?.(player.id) ?? []) {
      if (!(c.occurredAt > since)) continue;
      if (c.type === 'position_changed') add('position_changed', c.sourceSystem, c.sourceId, c.occurredAt, c.detail);
    }
    // A confirmed current club: each of these rows carries the clock of the
    // moment the confirmation happened, so no timestamp is invented.
    for (const sg of db.signings ?? []) {
      if (sg.playerId !== player.id) continue;
      if (!sg.endedAt && sg.ts > since) add('current_club_confirmed', 'signing', sg.id, sg.ts);
    }
    for (const o of db.orgs ?? []) {
      for (const row of o.squad ?? []) {
        if (row.playerId !== player.id) continue;
        const addedAt = row.addedAt ?? 0;
        if (o.verified && addedAt > since) add('current_club_confirmed', 'squad_row', `${o.id}:${row.playerId}`, addedAt);
      }
    }
    for (const claim of db.verClaims ?? []) {
      if (claim.subjectKind !== 'player' || claim.subjectId !== player.id) continue;
      if (claim.type !== 'organisation_affiliation' || claim.status !== 'verified') continue;
      if (claim.current === false) continue;
      if ((claim.verifiedAt ?? 0) > since) add('current_club_confirmed', 'verification_claim', claim.id, claim.verifiedAt);
    }

    return changesSinceDecision(out.filter(Boolean), since);
  }

  /** The head of the decision chain — exact, unlike last-by-timestamp. */
  const latestDecision = (roomId) => (db.roomDecisions ?? [])
    .find((d) => d.roomId === roomId && d.supersededById == null) ?? null;

  const latestSnapshot = (roomId, decision) => {
    if (decision?.snapshot?.snapshotId) {
      return (db.roomSnapshots ?? []).find((s) => s.id === decision.snapshot.snapshotId) ?? decision.snapshot;
    }
    return decision?.snapshot ?? null;
  };

  /** Current canonical facts, for the snapshot comparison. */
  function currentFacts(player, org) {
    const evidenceIds = db.evidence.filter((e) => e.playerId === player.id && !e.supersededBy).map((e) => e.id);
    const assessmentIds = db.assessments.filter((a) => a.orgId === org.id && a.playerId === player.id && a.state !== 'draft').map((a) => a.id);
    const combineResults = (ctx.combineProjection?.(player.id)?.results ?? []).map((r) => `${r.protocolId}@${r.protocolVersion}`);
    const trialIds = db.trials.filter((t) => t.orgId === org.id && t.playerId === player.id).map((t) => t.id);
    const references = (db.verReferences ?? []).filter((r) => r.playerId === player.id && r.status === 'active').length;
    return { evidenceIds, assessmentIds, combineResults, trialIds, references };
  }

  function trustFor(player) {
    const full = ctx.assemblePassport?.(player, { light: true }) ?? null;
    const profile = full && ctx.buildTrustProfile ? ctx.buildTrustProfile(player, { full }) : null;
    return { profile, safe: profile ? ctx.safeTrustProjection(profile, 'pro_club') : null };
  }

  // ------------------------------------------------------------- projection

  /**
   * Scan this organisation's ended rooms and project current Second Look
   * candidates. Derived live: nothing is cached, so a block, a suspension or a
   * removal takes effect on the very next read.
   */
  function projectCandidates(req, { playerId = null } = {}) {
    const org = req.org;
    const rooms = db.recruitmentCases.filter((c) => c.orgId === org.id && c.room
      && ['archived', 'closed', 'withdrawn'].includes(c.room.status)
      && (!playerId || c.playerId === playerId));
    // A club may have opened, archived and later opened a SECOND room for the
    // same player. "Since we last decided" has exactly one answer, so only the
    // most recent ended room per player projects a candidate — otherwise one
    // new full match raises one alert per historical room, which is the
    // duplicate-alert failure this milestone exists to prevent. Ties on the
    // decision clock (same-millisecond writes) fall back to the decision id so
    // the choice is stable across reads.
    const newest = new Map();
    for (const room of rooms) {
      const decision = latestDecision(room.id);
      if (!decision) continue;
      const prev = newest.get(room.playerId);
      const fresher = !prev
        || decision.createdAt > prev.decision.createdAt
        || (decision.createdAt === prev.decision.createdAt && String(decision.id) > String(prev.decision.id));
      if (fresher) newest.set(room.playerId, { room, decision });
    }

    const out = [];
    for (const { room, decision } of newest.values()) {
      const player = findPlayer(room.playerId);
      // Gates run BEFORE anything is computed about the player.
      const visible = !!player && orgCanSee(org, player);
      if (!visible) continue;
      const changes = collectChanges(player, org, decision.createdAt);
      if (!changes.length) continue;
      const snapshot = latestSnapshot(room.id, decision);
      const { profile, safe } = trustFor(player);
      const candidate = buildSecondLookCandidate({
        room, decision, snapshot, changes,
        trustMovement: trustLevelChanges(snapshot?.trust, profile),
        playerVisible: true, currentTrust: safe,
      });
      if (candidate) out.push({ candidate, room, player, decision, snapshot, profile, safe });
    }
    return out;
  }

  // ---------------------------------------------------------- persistence

  /**
   * An item belongs to ONE decision cycle. A club that reopens a room, reviews
   * again and archives again has made a NEW decision — so the next material
   * change surfaces a fresh item against that newest cycle, rather than
   * colliding with the terminal item from the previous one (§89).
   */
  const itemFor = (orgId, roomId, decisionId) => (db.secondLookItems ?? [])
    .find((i) => i.orgId === orgId && i.roomId === roomId && i.decisionId === decisionId) ?? null;

  /**
   * Reconcile persisted workflow state with what the world now looks like.
   * The cooldown is per change-fingerprint, so the SAME evidence can never
   * regenerate a handled item no matter how many projections it appears in —
   * and genuinely new evidence can, immediately.
   */
  function reconcile(req, { playerId = null } = {}) {
    const org = req.org;
    const projected = projectCandidates(req, { playerId });
    const live = [];
    for (const { candidate, room } of projected) {
      const existing = itemFor(org.id, room.id, candidate.decisionId);
      const verdict = secondLookStatus({ existing, candidate });
      // A handled item still exists: it belongs in the Reviewed and Dismissed
      // tabs. Suppression means "do not resurface as open", not "forget".
      if (verdict.action === 'suppress') { if (existing) live.push({ item: existing, candidate }); continue; }
      if (verdict.action === 'create') {
        const item = {
          id: nextId('slk'),
          orgId: org.id, playerId: candidate.playerId, roomId: candidate.roomId,
          decisionId: candidate.decisionId,
          policyVersion: SECOND_LOOK_POLICY_VERSION,
          triggerType: candidate.kind,
          changeFingerprints: candidate.changeFingerprints,
          directReasonCodes: candidate.directReasonCodes,
          status: 'open',
          createdAt: now(), updatedAt: now(),
          latestChangeAt: candidate.latestChangeAt,
          history: [{ at: now(), action: 'surfaced', by: null }],
        };
        db.secondLookItems.push(item);
        vmetric('second_look_created');
        // Internal only — an org_user audience, never the player or guardian.
        for (const u of db.users.filter((x) => x.orgId === org.id && !x.removedAt && x.id === room.ownerUserId)) {
          notify({ kind: 'org_user', id: u.id }, 'second_look',
            'New evidence may relate to a player you previously archived.', item.id);
        }
        live.push({ item, candidate });
        continue;
      }
      if (verdict.action === 'reopen') {
        existing.status = 'open';
        existing.changeFingerprints = candidate.changeFingerprints;
        existing.directReasonCodes = candidate.directReasonCodes;
        existing.triggerType = candidate.kind;
        existing.latestChangeAt = candidate.latestChangeAt;
        existing.updatedAt = now();
        existing.history.push({ at: now(), action: 'resurfaced', by: null, reason: verdict.reason });
        vmetric('second_look_created');
      } else if (verdict.action === 'update') {
        existing.changeFingerprints = candidate.changeFingerprints;
        existing.directReasonCodes = candidate.directReasonCodes;
        existing.triggerType = candidate.kind;
        existing.latestChangeAt = candidate.latestChangeAt;
        existing.updatedAt = now();
      }
      if (existing && secondLookExpired(existing)) {
        existing.status = 'expired';
        existing.updatedAt = now();
      }
      live.push({ item: existing, candidate });
    }
    persistNow();
    return live;
  }

  /** Wire shape. Carries facts the club could already read, and no org id. */
  const itemView = ({ item, candidate }) => safeM18Projection({
    id: item.id,
    orgId: item.orgId,
    playerId: item.playerId,
    playerName: candidate.playerName ?? null,
    roomId: item.roomId,
    decisionId: item.decisionId,
    status: item.status,
    policyVersion: item.policyVersion,
    kind: candidate.kind,
    kindLabel: SECOND_LOOK_KIND_COPY[candidate.kind],
    strength: candidate.strength,
    archivedStatus: candidate.archivedStatus,
    archiveReasonCodes: candidate.archiveReasonCodes,
    directReasonCodes: candidate.directReasonCodes,
    // Reasons the club gave that player evidence can never resolve, reported
    // so no surface can imply otherwise.
    unresolvedReasonCodes: candidate.unresolvedReasonCodes,
    decisionAt: candidate.decisionAt,
    changes: candidate.changes.map((c) => ({
      type: c.type, text: c.text, relatesTo: c.relatesTo, negative: c.negative,
      occurredAt: c.occurredAt, fingerprint: c.fingerprint,
    })),
    changeCount: candidate.changeCount,
    trustMovement: candidate.trustMovement,
    currentTrust: candidate.currentTrust,
    summary: candidate.summary,
    latestChangeAt: candidate.latestChangeAt,
    reviewedAt: item.reviewedAt ?? null,
    reviewedBy: item.reviewedBy ?? null,
    dismissedAt: item.dismissedAt ?? null,
    dismissReason: item.dismissReason ?? null,
    reopenedAt: item.reopenedAt ?? null,
    disclaimer: SECOND_LOOK_DISCLAIMER,
  });

  // ================================================================= ROUTES

  orgRouter.get('/second-look', (req, res) => {
    const live = reconcile(req);
    const status = String(req.query.status ?? 'open');
    const byId = new Map(live.map((l) => [l.item.id, l]));
    let items = live;
    if (status !== 'all') items = items.filter((l) => l.item.status === status);

    const named = items.map(({ item, candidate }) => {
      const room = db.recruitmentCases.find((c) => c.id === item.roomId);
      return { item, candidate: { ...candidate, playerName: room?.playerName ?? null } };
    });
    const ordered = orderSecondLook(named.map((n) => ({ ...n.candidate, id: n.item.id, status: n.item.status })))
      .map((c) => byId.get(c.id))
      .filter(Boolean)
      .map(({ item }) => named.find((n) => n.item.id === item.id))
      .filter(Boolean);

    const limit = clampPage(req.query.limit);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json({
      items: ordered.slice(offset, offset + limit).map(itemView),
      total: ordered.length, limit, offset,
      counts: {
        open: live.filter((l) => l.item.status === 'open').length,
        reviewed: live.filter((l) => l.item.status === 'reviewed').length,
        dismissed: live.filter((l) => l.item.status === 'dismissed').length,
      },
      policyVersion: SECOND_LOOK_POLICY_VERSION,
      disclaimer: SECOND_LOOK_DISCLAIMER,
      note: 'Second Look reports what changed since your decision. It never judges that decision, and a room only reopens when you choose to reopen it.',
    });
  });

  function findItem(req, res) {
    const item = (db.secondLookItems ?? []).find((i) => i.id === req.params.id && i.orgId === req.org.id);
    // A foreign item is indistinguishable from one that never existed.
    if (!item) { res.status(404).json({ error: 'SECOND_LOOK_NOT_FOUND' }); return null; }
    return item;
  }

  orgRouter.get('/second-look/:id', (req, res) => {
    const item = findItem(req, res);
    if (!item) return;
    const live = reconcile(req, { playerId: item.playerId }).find((l) => l.item.id === item.id);
    const room = db.recruitmentCases.find((c) => c.id === item.roomId);
    const player = findPlayer(item.playerId);
    // The player may have become invisible since the item was created. The
    // internal workflow record survives; the player projection does not.
    if (!player || !orgCanSee(req.org, player)) {
      return res.json({
        item: safeM18Projection({ ...item, playerName: null, playerAvailable: false }),
        unavailableNote: 'Player data is currently unavailable to your organisation under the standing rules. Your internal record remains.',
      });
    }
    if (!live) {
      return res.json({
        item: safeM18Projection({ ...item, playerName: room?.playerName ?? null, playerAvailable: true }),
        note: 'The changes behind this item are no longer current.',
      });
    }
    res.json({ item: itemView({ item, candidate: { ...live.candidate, playerName: room?.playerName ?? null } }) });
  });

  /** The focused before/now comparison — relevant rows only, never a Passport dump. */
  orgRouter.get('/second-look/:id/changes', (req, res) => {
    const item = findItem(req, res);
    if (!item) return;
    const player = findPlayer(item.playerId);
    if (!player || !orgCanSee(req.org, player)) {
      return res.status(200).json({ available: false, unavailableNote: 'Player data is currently unavailable to your organisation under the standing rules.' });
    }
    const room = db.recruitmentCases.find((c) => c.id === item.roomId);
    const decision = latestDecision(item.roomId);
    const snapshot = latestSnapshot(item.roomId, decision);
    const { profile, safe } = trustFor(player);
    const facts = currentFacts(player, req.org);
    const changes = decision ? collectChanges(player, req.org, decision.createdAt) : [];
    res.json({
      previous: {
        at: decision?.createdAt ?? null,
        reasonCodes: decision?.reasonCodes ?? [],
        recommendation: decision?.recommendation ?? null,
        trust: snapshot?.trust ? { score: snapshot.trust.score, band: snapshot.trust.band, policyVersion: snapshot.trust.policyVersion } : null,
        // Never fabricate a previous value we did not record.
        note: snapshot ? null : 'Previous detail unavailable — no decision-time snapshot was recorded.',
      },
      current: { trust: safe, playerName: room?.playerName ?? null },
      comparison: compareToSnapshot(snapshot, { ...facts, trust: safe }),
      changes: changes.map((c) => ({ type: c.type, text: c.text, occurredAt: c.occurredAt, negative: c.negative })),
      trustMovement: trustLevelChanges(snapshot?.trust, profile),
      unresolvedReasonCodes: (decision?.reasonCodes ?? []).filter((c) => CLUB_SIDE_REASONS.includes(c)),
      reasonMap: Object.fromEntries((decision?.reasonCodes ?? []).map((c) => [c, REASON_CHANGE_MAP[c] ?? []])),
      note: 'Only changes relevant to this decision are shown. A Trust Score movement is context — the underlying facts are the reason this item exists.',
      disclaimer: SECOND_LOOK_DISCLAIMER,
    });
  });

  const transition = (req, res, item, to) => {
    if (!canSecondLookTransition(item.status, to)) {
      res.status(409).json({ error: 'SECOND_LOOK_TRANSITION_INVALID', from: item.status, to });
      return false;
    }
    return true;
  };

  orgRouter.post('/second-look/:id/review', (req, res) => {
    const item = findItem(req, res);
    if (!item) return;
    if (limited(`slk:act:${req.org.id}`, LIMITS.reviewActionsPerHour, 3_600_000)) return res.status(429).json({ error: 'RATE_LIMITED' });
    if (!transition(req, res, item, 'reviewed')) return;
    item.status = 'reviewed';
    item.reviewedAt = now();
    item.reviewedBy = { userId: req.orgUser.id, name: req.orgUser.name };
    item.updatedAt = now();
    item.history.push({ at: now(), action: 'reviewed', by: item.reviewedBy });
    vmetric('second_look_reviewed');
    persistNow();
    res.json({ item: safeM18Projection(item) });
  });

  orgRouter.post('/second-look/:id/dismiss', (req, res) => {
    const item = findItem(req, res);
    if (!item) return;
    if (limited(`slk:act:${req.org.id}`, LIMITS.reviewActionsPerHour, 3_600_000)) return res.status(429).json({ error: 'RATE_LIMITED' });
    const reason = req.body?.reason ?? null;
    if (reason != null && !DISMISSAL_REASONS.includes(reason)) {
      return res.status(400).json({ error: 'SECOND_LOOK_REASON_UNKNOWN', allowed: DISMISSAL_REASONS });
    }
    if (!transition(req, res, item, 'dismissed')) return;
    item.status = 'dismissed';
    item.dismissedAt = now();
    item.dismissedBy = { userId: req.orgUser.id, name: req.orgUser.name };
    item.dismissReason = reason;
    item.updatedAt = now();
    item.history.push({ at: now(), action: 'dismissed', by: item.dismissedBy, reason });
    vmetric('second_look_dismissed');
    persistNow();
    // Dismissal changes nothing about the player's record — it is a private
    // note about this organisation's own queue.
    res.json({ item: safeM18Projection(item), note: 'Dismissed for your organisation only. Nothing about the player’s record changes.' });
  });

  /**
   * Reopen the linked room. This is the ONLY way a Second Look reaches the
   * pipeline, it requires an explicit recruiter action, and it runs through
   * M17's own reopen path rather than touching the case here.
   */
  orgRouter.post('/second-look/:id/reopen-room', (req, res) => {
    const item = findItem(req, res);
    if (!item) return;
    if (limited(`slk:act:${req.org.id}`, LIMITS.reviewActionsPerHour, 3_600_000)) return res.status(429).json({ error: 'RATE_LIMITED' });
    const room = db.recruitmentCases.find((c) => c.id === item.roomId && c.orgId === req.org.id && c.room);
    if (!room) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    const player = findPlayer(item.playerId);
    if (!player || !orgCanSee(req.org, player)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    if (!ctx.reopenRoom) return res.status(503).json({ error: 'ROOM_ENGINE_UNAVAILABLE' });

    const out = ctx.reopenRoom({
      req, room, to: 'under_review',
      reasonCodes: req.body?.reasonCodes ?? ['continue_monitoring'],
      sourceContext: 'second_look', sourceRef: item.id,
    });
    if (!out.ok) return res.status(out.status).json(out);

    item.status = 'reopened_room';
    item.reopenedAt = now();
    item.reopenedBy = { userId: req.orgUser.id, name: req.orgUser.name };
    item.updatedAt = now();
    item.history.push({ at: now(), action: 'reopened_room', by: item.reopenedBy });
    vmetric('second_look_room_reopened');
    broadcast?.('recruitment_room_reopened_from_second_look', { orgId: req.org.id, roomId: room.id, itemId: item.id });
    persistNow();
    res.json({ item: safeM18Projection(item), room: out.room, note: 'The archived decision remains in the room’s history. Reopening adds to it.' });
  });

  ctx.secondLookCollectChanges = collectChanges;
  ctx.secondLookLatestDecision = latestDecision;
  ctx.secondLookReconcile = reconcile;
  ctx.secondLookItemsFor = (orgId, playerId) => (db.secondLookItems ?? []).filter((i) => i.orgId === orgId && i.playerId === playerId);
  void SECOND_LOOK_STATUSES;
  void isLead;
}
