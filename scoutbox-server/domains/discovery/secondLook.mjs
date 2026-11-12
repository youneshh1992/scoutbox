// Second Look owns no player truth: it reads the source stores and stores only workflow (which item a recruiter
// reviewed, dismissed or acted on). Reopening a room goes through the rooms' own reopen path.
import { asReconciling } from '../../writeRules.mjs';
import { PROVIDERS } from '../development/public.mjs';
import {
  SECOND_LOOK_POLICY_VERSION,
  SECOND_LOOK_STATUSES,
  canSecondLookTransition,
  SECOND_LOOK_DISCLAIMER,
  SECOND_LOOK_KIND_COPY,
  normalizeMaterialChange,
  changesSinceDecision,
  buildSecondLookCandidate,
  secondLookStatus,
  secondLookExpired,
  orderSecondLook,
  compareToSnapshot,
  trustLevelChanges,
  POLICY,
  LIMITS,
  safeM18Projection,
  CLUB_SIDE_REASONS,
  REASON_CHANGE_MAP,
} from './shared.mjs';
import { rateLimitedBody, limitCheck } from '../platform/rateLimit.mjs';
import { now } from '../platform/clock.mjs';
import { discoveryInput } from './schemas.mjs';

export function registerSecondLook(ctx) {
  const { orgRouter, nextId, notify, broadcast, findPlayer, orgCanSee, isLead, vmetric, discovery, unit } = ctx;
  const dreads = ctx.discoveryReads;
  if (typeof dreads?.secondLook?.byKey !== 'function' || typeof discovery?.secondLook?.create !== 'function')
    throw new TypeError('registerSecondLook needs the discovery repository and discoveryReads from the data layer');
  const reads = ctx.recruitmentReads;
  if (typeof reads?.signings?.forPlayer !== 'function')
    throw new TypeError('registerSecondLook needs recruitmentReads (signings) from the data layer');

  const limited = limitCheck(ctx.rateLimit);

  // ------------------------------------------------------ change collection

  function collectChanges(player, org, since) {
    const out = [];
    const add = (type, sourceSystem, sourceId, occurredAt, detail) =>
      out.push(normalizeMaterialChange({ type, subjectId: player.id, sourceSystem, sourceId, occurredAt, detail }));

    // --- evidence ----------------------------------------------------------
    for (const e of ctx.scoutingReads.evidence.forPlayer(player.id)) {
      if (e.recordedAt > since && !e.correctionOf) {
        add(e.claimType === 'footage' ? 'full_match_added' : 'evidence_added', 'evidence', e.id, e.recordedAt);
      }
      // A tier upgrade counts only when it happened after the record was created; evidence written with a tier is
      // a new item, not a later confirmation.
      const reviewedAt = e.verification?.reviewedAt ?? 0;
      if (
        reviewedAt > since &&
        reviewedAt > (e.recordedAt ?? 0) &&
        ['coach_confirmed', 'club_assessed', 'independent'].includes(e.verification?.status)
      ) {
        add('evidence_quality_improved', 'evidence', e.id, reviewedAt);
      }
      // Superseded: the correcting row carries the clock, the original does not.
      if (e.supersededBy) {
        const next = ctx.scoutingReads.evidence.byId(e.supersededBy);
        if (next && next.recordedAt > since) add('evidence_removed', 'evidence', e.id, next.recordedAt);
      }
      for (const d of e.disputes ?? []) {
        if (d.at > since && d.status === 'open') add('evidence_disputed', 'evidence', e.id, d.at);
      }
    }

    // --- verified references ----------------------------------------------
    for (const r of ctx.verificationReads.references.forPlayer(player.id)) {
      if (r.status === 'active' && r.createdAt > since) add('verified_reference_added', 'reference', r.id, r.createdAt);
      if (r.withdrawnAt && r.withdrawnAt > since) add('verified_reference_revoked', 'reference', r.id, r.withdrawnAt);
    }

    // --- Combine -----------------------------------------------------------
    // A result from a test-only provider is labelled simulated elsewhere and is not recruitment evidence.
    const boxReads = ctx.boxCamReads;
    const playerAttempts = [...boxReads.attempts.forPlayer(player.id)].reverse();
    const playerSessions = boxReads.sessions.forPlayer(player.id);
    const sessionById = new Map(playerSessions.map((s) => [s.id, s]));
    for (const a of playerAttempts) {
      if (a.combineState !== 'combine_verified' || !a.completedAt) continue;
      if (PROVIDERS[a.provider]?.testOnly) continue;
      // The live effective state: an invalidated bound session removes it.
      const session = sessionById.get(a.boxSessionId);
      if (session?.verificationState === 'invalidated') continue;
      if (a.completedAt > since)
        add('combine_verified_added', 'combine', `${a.protocolId}@${a.protocolVersion}`, a.completedAt);
    }

    // --- Box Cam -----------------------------------------------------------
    // Not one change per session: only the first development evidence since the review, or a completed
    // coach-assigned block, is material.
    const sessions = playerSessions.filter(
      (s) => ['verified', 'partially_verified'].includes(s.verificationState) && s.finalizedAt,
    );
    const fresh = sessions.filter((s) => s.finalizedAt > since);
    const hadBefore = sessions.some((s) => s.finalizedAt <= since);
    if (!hadBefore && fresh.length >= POLICY.boxCam.minSessionsForFirstEvidence) {
      const first = fresh.sort((a, b) => a.finalizedAt - b.finalizedAt)[0];
      add('development_evidence_started', 'box_cam', first.id, first.finalizedAt);
    }
    for (const a of boxReads.assignments.forPlayer(player.id)) {
      if (a.orgId !== org.id) continue;
      if (a.state === 'completed' && a.updatedAt > since)
        add('development_block_completed', 'box_cam', a.id, a.updatedAt);
    }

    // --- trials, assessments, gap closure ----------------------------------
    for (const t of reads.trials.forOrgPlayer(org.id, player.id)) {
      const filedAt = t.report?.filedAt ?? 0;
      if (t.status === 'reported' && filedAt > since) add('trial_completed', 'trial', t.id, filedAt);
    }
    for (const a of ctx.scoutingReads.assessments.forOrgPlayer(org.id, player.id)) {
      if (a.submittedAt && a.submittedAt > since) add('assessment_submitted', 'assessment', a.id, a.submittedAt);
    }
    for (const s of ctx.insightReads.suggestions.forOrgPlayer(org.id, player.id)) {
      if (s.status === 'supplied' && s.updatedAt > since) add('evidence_gap_closed', 'evidence_gap', s.id, s.updatedAt);
    }

    // --- Combine integrity -------------------------------------------------
    // Fingerprinted on the session, so one invalidation stays one change however many projections reflect it.
    for (const session of playerSessions) {
      const events = session.integrityEvents ?? [];
      if (!events.length) continue;
      const backed = playerAttempts.some(
        (a) =>
          a.boxSessionId === session.id && a.combineState === 'combine_verified' && !PROVIDERS[a.provider]?.testOnly,
      );
      if (!backed) continue;
      for (const ev of events) {
        if (!(ev.at > since)) continue;
        if (ev.type === 'invalidated') add('combine_verified_invalidated', 'combine_integrity', session.id, ev.at);
        if (ev.type === 'restored') add('combine_verified_restored', 'combine_integrity', session.id, ev.at);
      }
    }

    // --- source changes with their own clocks -------------------------------
    // These read the clock of the change itself or do not fire: no other timestamp means the same thing.
    for (const c of ctx.sourceChangesFor?.(player.id) ?? []) {
      if (!(c.occurredAt > since)) continue;
      if (c.type === 'position_changed') add('position_changed', c.sourceSystem, c.sourceId, c.occurredAt, c.detail);
    }
    for (const sg of reads.signings.forPlayer(player.id)) {
      if (!sg.endedAt && sg.ts > since) add('current_club_confirmed', 'signing', sg.id, sg.ts);
    }
    // A club's shadow list confirms no club.
    for (const row of ctx.scoutingReads.squad.forPlayer(player.id)) {
      const o = ctx.byId.org(row.orgId);
      if (o?.verified && row.addedAt > since)
        add('current_club_confirmed', 'squad_row', `${o.id}:${row.playerId}`, row.addedAt);
    }
    return changesSinceDecision(out.filter(Boolean), since);
  }

  /** The head of the decision chain, which last-by-timestamp would not reliably find. */
  const latestDecision = (roomId) => reads.decisions.forRoom(roomId).find((d) => d.supersededById == null) ?? null;

  const latestSnapshot = (roomId, decision) => {
    if (decision?.snapshot?.snapshotId) {
      return reads.snapshots.byId(decision.snapshot.snapshotId) ?? decision.snapshot;
    }
    return decision?.snapshot ?? null;
  };

  function currentFacts(player, org) {
    const evidenceIds = ctx.scoutingReads.evidence.currentForPlayer(player.id).map((e) => e.id);
    const assessmentIds = ctx.scoutingReads.assessments
      .forOrgPlayer(org.id, player.id)
      .filter((a) => a.state !== 'draft')
      .map((a) => a.id);
    const combineResults = (ctx.combineProjection?.(player.id)?.results ?? []).map(
      (r) => `${r.protocolId}@${r.protocolVersion}`,
    );
    const trialIds = reads.trials.forOrgPlayer(org.id, player.id).map((t) => t.id);
    const references = ctx.verificationReads.references.activeForPlayer(player.id).length;
    return { evidenceIds, assessmentIds, combineResults, trialIds, references };
  }

  function trustFor(player) {
    const full = ctx.assemblePassport?.(player, { light: true }) ?? null;
    const profile = full && ctx.buildTrustProfile ? ctx.buildTrustProfile(player, { full }) : null;
    return { profile, safe: profile ? ctx.safeTrustProjection(profile, 'pro_club') : null };
  }

  // ------------------------------------------------------------- projection

  /** Derived live, so a block, suspension or removal takes effect on the next read. */
  function projectCandidates(req, { playerId = null } = {}) {
    const org = req.org;
    const rooms = reads.cases
      .forOrg(org.id)
      .filter(
        (c) =>
          c.room &&
          ['archived', 'closed', 'withdrawn'].includes(c.room.status) &&
          (!playerId || c.playerId === playerId),
      );
    // Only the most recent ended room per player projects a candidate, or one new full match would raise an alert
    // per historical room. Same-millisecond ties fall back to the decision id so the choice is stable.
    const newest = new Map();
    for (const room of rooms) {
      const decision = latestDecision(room.id);
      if (!decision) continue;
      const prev = newest.get(room.playerId);
      const fresher =
        !prev ||
        decision.createdAt > prev.decision.createdAt ||
        (decision.createdAt === prev.decision.createdAt && String(decision.id) > String(prev.decision.id));
      if (fresher) newest.set(room.playerId, { room, decision });
    }

    const out = [];
    for (const { room, decision } of newest.values()) {
      const player = findPlayer(room.playerId);
      // Gates run before anything is computed about the player.
      const visible = !!player && orgCanSee(org, player);
      if (!visible) continue;
      const changes = collectChanges(player, org, decision.createdAt);
      if (!changes.length) continue;
      const snapshot = latestSnapshot(room.id, decision);
      const { profile, safe } = trustFor(player);
      const candidate = buildSecondLookCandidate({
        room,
        decision,
        snapshot,
        changes,
        trustMovement: trustLevelChanges(snapshot?.trust, profile),
        playerVisible: true,
        currentTrust: safe,
      });
      if (candidate) out.push({ candidate, room, player, decision, snapshot, profile, safe });
    }
    return out;
  }

  // ---------------------------------------------------------- persistence

  // An item belongs to one decision cycle: re-archiving a reopened room is a new decision, so the next change
  // surfaces a fresh item rather than colliding with the previous cycle's terminal one.
  const itemFor = (orgId, roomId, decisionId) => dreads.secondLook.byKey(orgId, roomId, decisionId);

  /**
   * Reconciles stored workflow state with current facts when the queue is read (there is no scheduler). Everything
   * one read creates, resurfaces, updates or expires commits in one unit; a read that finds nothing new writes nothing.
   */
  function reconcile(req, { playerId = null } = {}) {
    const org = req.org;
    const projected = projectCandidates(req, { playerId });
    return asReconciling(() =>
      unit(() => {
        const live = [];
        for (const { candidate, room } of projected) {
          const existing = itemFor(org.id, room.id, candidate.decisionId);
          const verdict = secondLookStatus({ existing, candidate });
          // Suppression means "do not resurface as open", not "forget": the item stays in the Reviewed/Dismissed tabs.
          if (verdict.action === 'suppress') {
            if (existing) live.push({ item: existing, candidate });
            continue;
          }
          const at = now();
          if (verdict.action === 'create') {
            const item = discovery.secondLook.create({
              id: nextId('slk'),
              orgId: org.id,
              playerId: candidate.playerId,
              roomId: candidate.roomId,
              decisionId: candidate.decisionId,
              policyVersion: SECOND_LOOK_POLICY_VERSION,
              triggerType: candidate.kind,
              changeFingerprints: candidate.changeFingerprints,
              directReasonCodes: candidate.directReasonCodes,
              status: 'open',
              createdAt: at,
              updatedAt: at,
              latestChangeAt: candidate.latestChangeAt,
              history: [{ at, action: 'surfaced', by: null }],
            });
            vmetric('second_look_created');
            // Names the player: it goes only to the scout who owned the Room, visibility is established above, and
            // "a player you archived" is useless to someone who has archived dozens.
            const owner = room.ownerUserId ? ctx.byId.user(room.ownerUserId) : null;
            if (owner && owner.orgId === org.id && !owner.removedAt) {
              notify(
                { kind: 'org_user', id: owner.id },
                'second_look',
                `Second Look — ${room.playerName}: new evidence since your organisation archived this Room.`,
                item.id,
              );
            }
            live.push({ item, candidate });
            continue;
          }
          const refresh = {
            changeFingerprints: candidate.changeFingerprints,
            directReasonCodes: candidate.directReasonCodes,
            triggerType: candidate.kind,
            latestChangeAt: candidate.latestChangeAt,
          };
          // Whether the item, as the act leaves it, has lapsed by now.
          const lapsed = (status) => secondLookExpired({ ...existing, ...refresh, status, updatedAt: at }, at);
          let item = existing;
          if (verdict.action === 'reopen') {
            item = discovery.secondLook.resurface(existing.id, {
              refresh,
              at,
              reason: verdict.reason,
              expired: lapsed('open'),
            });
            vmetric('second_look_created');
          } else if (verdict.action === 'update') {
            item = discovery.secondLook.refresh(existing.id, { refresh, at, expired: lapsed(existing.status) });
          } else if (secondLookExpired(existing, at)) {
            item = discovery.secondLook.expire(existing.id, { at });
          }
          live.push({ item, candidate });
        }
        return live;
      }),
    );
  }

  const storedView = (i) => ({
    id: i.id,
    playerId: i.playerId,
    roomId: i.roomId,
    decisionId: i.decisionId,
    policyVersion: i.policyVersion,
    triggerType: i.triggerType,
    changeFingerprints: i.changeFingerprints,
    directReasonCodes: i.directReasonCodes,
    status: i.status,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    latestChangeAt: i.latestChangeAt,
    reviewedAt: i.reviewedAt,
    reviewedBy: i.reviewedBy,
    dismissedAt: i.dismissedAt,
    dismissedBy: i.dismissedBy,
    dismissReason: i.dismissReason,
    reopenedAt: i.reopenedAt,
    reopenedBy: i.reopenedBy,
    history: i.history,
  });

  const itemView = ({ item, candidate }) =>
    safeM18Projection({
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
      unresolvedReasonCodes: candidate.unresolvedReasonCodes,
      decisionAt: candidate.decisionAt,
      changes: candidate.changes.map((c) => ({
        type: c.type,
        text: c.text,
        relatesTo: c.relatesTo,
        negative: c.negative,
        occurredAt: c.occurredAt,
        fingerprint: c.fingerprint,
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
    const query = discoveryInput(res, 'secondLookQuery', req.query, 'query');
    if (!query) return;
    const live = reconcile(req);
    const status = query.status ?? 'open';
    const byId = new Map(live.map((l) => [l.item.id, l]));
    let items = live;
    if (status !== 'all') items = items.filter((l) => l.item.status === status);

    const named = items.map(({ item, candidate }) => {
      const room = reads.cases.byId(item.roomId);
      return { item, candidate: { ...candidate, playerName: room?.playerName ?? null } };
    });
    const ordered = orderSecondLook(named.map((n) => ({ ...n.candidate, id: n.item.id, status: n.item.status })))
      .map((c) => byId.get(c.id))
      .filter(Boolean)
      .map(({ item }) => named.find((n) => n.item.id === item.id))
      .filter(Boolean);

    const limit = query.limit === undefined ? LIMITS.pageSize : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    res.json({
      items: ordered.slice(offset, offset + limit).map(itemView),
      total: ordered.length,
      limit,
      offset,
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
    const item = dreads.secondLook.forOrgById(String(req.params.id), req.org.id);
    if (!item) {
      res.status(404).json({ error: 'SECOND_LOOK_NOT_FOUND' });
      return null;
    }
    return item;
  }

  orgRouter.get('/second-look/:id', (req, res) => {
    const item = findItem(req, res);
    if (!item) return;
    const live = reconcile(req, { playerId: item.playerId }).find((l) => l.item.id === item.id);
    const current = live?.item ?? item;
    const room = reads.cases.byId(item.roomId);
    const player = findPlayer(item.playerId);
    // The player may have become invisible since: the workflow record survives, the player projection does not.
    if (!player || !orgCanSee(req.org, player)) {
      return res.json({
        item: { ...storedView(current), playerName: null, playerAvailable: false },
        unavailableNote:
          'Player data is currently unavailable to your organisation under the standing rules. Your internal record remains.',
      });
    }
    if (!live) {
      return res.json({
        item: { ...storedView(current), playerName: room?.playerName ?? null, playerAvailable: true },
        note: 'The changes behind this item are no longer current.',
      });
    }
    res.json({
      item: itemView({ item: current, candidate: { ...live.candidate, playerName: room?.playerName ?? null } }),
    });
  });

  orgRouter.get('/second-look/:id/changes', (req, res) => {
    const item = findItem(req, res);
    if (!item) return;
    const player = findPlayer(item.playerId);
    if (!player || !orgCanSee(req.org, player)) {
      return res.status(200).json({
        available: false,
        unavailableNote: 'Player data is currently unavailable to your organisation under the standing rules.',
      });
    }
    const room = reads.cases.byId(item.roomId);
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
        trust: snapshot?.trust
          ? { score: snapshot.trust.score, band: snapshot.trust.band, policyVersion: snapshot.trust.policyVersion }
          : null,
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
    if (limited('second_look_action', req.org.id)) return res.status(429).json(rateLimitedBody('second_look_action'));
    if (!discoveryInput(res, 'none', req.body)) return;
    if (!transition(req, res, item, 'reviewed')) return;
    const at = now();
    const by = { userId: req.orgUser.id, name: req.orgUser.name };
    const stored = discovery.secondLook.review(item.id, { by, at });
    vmetric('second_look_reviewed');
    res.json({ item: storedView(stored) });
  });

  orgRouter.post('/second-look/:id/dismiss', (req, res) => {
    const item = findItem(req, res);
    if (!item) return;
    if (limited('second_look_action', req.org.id)) return res.status(429).json(rateLimitedBody('second_look_action'));
    const body = discoveryInput(res, 'secondLookDismiss', req.body);
    if (!body) return;
    const reason = body.reason ?? null;
    if (!transition(req, res, item, 'dismissed')) return;
    const at = now();
    const by = { userId: req.orgUser.id, name: req.orgUser.name };
    const stored = discovery.secondLook.dismiss(item.id, { by, at, reason });
    vmetric('second_look_dismissed');
    res.json({
      item: storedView(stored),
      note: 'Dismissed for your organisation only. Nothing about the player’s record changes.',
    });
  });

  /** The only way a Second Look reaches the pipeline, through the rooms' own reopen path. */
  orgRouter.post('/second-look/:id/reopen-room', (req, res) => {
    const item = findItem(req, res);
    if (!item) return;
    if (limited('second_look_action', req.org.id)) return res.status(429).json(rateLimitedBody('second_look_action'));
    const body = discoveryInput(res, 'secondLookReopen', req.body);
    if (!body) return;
    const found = reads.cases.byId(item.roomId);
    const room = found && found.orgId === req.org.id && found.room ? found : null;
    if (!room) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    const player = findPlayer(item.playerId);
    if (!player || !orgCanSee(req.org, player)) return res.status(403).json({ error: 'NOT_VISIBLE' });
    if (!ctx.reopenRoom) return res.status(503).json({ error: 'ROOM_ENGINE_UNAVAILABLE' });

    const { out, stored } = unit(() => {
      const reopened = ctx.reopenRoom({
        req,
        room,
        to: 'under_review',
        reasonCodes: body.reasonCodes ?? ['continue_monitoring'],
        sourceContext: 'second_look',
        sourceRef: { id: item.id },
      });
      if (!reopened.ok) return { out: reopened, stored: null };
      const at = now();
      const by = { userId: req.orgUser.id, name: req.orgUser.name };
      return {
        out: reopened,
        stored: discovery.secondLook.markRoomReopened(item.id, { by, at }),
      };
    });
    if (!out.ok) return res.status(out.status).json(out);
    vmetric('second_look_room_reopened');
    broadcast?.('recruitment_room_reopened_from_second_look', { orgId: req.org.id, roomId: room.id, itemId: item.id });
    res.json({
      item: storedView(stored),
      room: out.room,
      note: 'The archived decision remains in the room’s history. Reopening adds to it.',
    });
  });

  ctx.secondLookCollectChanges = collectChanges;
  ctx.secondLookLatestDecision = latestDecision;
  ctx.secondLookReconcile = reconcile;
  void SECOND_LOOK_STATUSES;
  void isLead;
}
