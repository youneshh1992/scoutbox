// M17 — Recruitment Rooms: stores, the room projector and the org routes.
//
// A Room is the CLUB's private decision workspace around one player. It is a
// facet of the M12 recruitment case, never a second pipeline: `room.status` is
// canonical and `case.stage` is derived from it by `applyStatus` alone.
//
// Three rules govern every line below.
//   1. The Room composes canonical projections; it never re-derives player
//      truth and never stores a copy of it.
//   2. The Room is not authorization. `orgCanSee` re-runs on EVERY read, so a
//      block, a suspension, a removal or a visibility change stops the player
//      projections immediately — the internal record remains, the player data
//      does not.
//   3. Nothing the player, their guardian, another club or (by default) Trust
//      & Safety can read is ever written here.
import {
  ROOM_STATUSES, ROOM_STATUS_LABELS, OPEN_ROOM_STATUSES, ROOM_TRANSITIONS,
  PRO_STAGES, GRASSROOTS_STAGES, stageForRoomStatus, roomStatusForStage,
  validateTransition, validateReasonCodes, validateDecision, REASON_CODES,
  ALL_REASON_CODES, PROHIBITED_REASON_CODES, RECOMMENDATIONS,
  decisionReadiness, roomHealth, ROOM_HEALTH_LABELS, roomRole, roomCan,
  normaliseSourceContext, SOURCE_CONTEXTS, TASK_STATES, canTaskTransition,
  LINKED_RESOURCE_TYPES, EVIDENCE_REVIEW_STATES, ROOM_PRIORITIES,
  ROOM_PRIORITY_NOTE, roomActivity, buildRoomSnapshot, roomSummary, roomFunnel,
  secondLookEvent, ROOM_TRUST_NOTE, ROOM_DEV_NOTE, ROOM_PRIVACY_NOTE,
  ROOM_UNAVAILABLE_NOTE, LIMITS, clampPage, validateTag, SNAPSHOT_STATUSES,
} from './shared.mjs';

export function registerRooms(ctx) {
  const {
    db, orgRouter, adminRouter, nextId, persistNow, notify, ledgerAppend, broadcast,
    findPlayer, moderateOrRefuse, playerViewForOrg, orgCanSee, isLead, audit, vmetric,
  } = ctx;

  // ------------------------------------------------------------- utilities

  const now = () => Date.now();
  const orgUsers = (orgId) => db.users.filter((u) => u.orgId === orgId && !u.removedAt);
  const orgUser = (orgId, userId) => orgUsers(orgId).find((u) => u.id === userId) ?? null;

  // Fixed-window counters for the abuse surfaces. Same shape as the in-memory
  // guards M13 already uses; nothing here is security-critical state.
  const buckets = new Map();
  function limited(key, max, windowMs) {
    const t = now();
    const b = buckets.get(key);
    if (!b || t - b.start > windowMs) { buckets.set(key, { start: t, n: 1 }); return false; }
    b.n += 1;
    return b.n > max;
  }

  // Comment bodies are stored inert: markup is removed on write, so no renderer
  // anywhere — ours or a future one — can be talked into executing it.
  const plainText = (s, max) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, max);

  const isRoom = (c) => !!c?.room;

  /**
   * The player header inside a Room.
   *
   * `playerViewForOrg` carries a LEGACY `trustScore` from the original
   * safeguarding heuristic, which predates the M16.2 Trust Score. Two different
   * numbers both called "trust" in one header is exactly how an
   * evidence-confidence score gets read as a player rating, so the Room shows
   * one: the M16.2 score, with its disclaimer attached. The legacy field is
   * untouched everywhere else — this is a presentation decision local to M17.
   */
  function roomPlayerView(player, org) {
    const view = playerViewForOrg(player, org);
    if (!view) return null;
    const { trustScore, trust, ...rest } = view;
    return rest;
  }

  /** The single writer of room status. `case.stage` is derived here and only here. */
  function applyStatus(room, status, org) {
    room.room.status = status;
    room.stage = stageForRoomStatus(status, org.level);
    room.room.updatedAt = now();
    if (status === 'archived') room.room.archivedAt = now();
    if (status === 'closed') room.room.closedAt = now();
    if (OPEN_ROOM_STATUSES.includes(status)) { room.room.archivedAt = null; room.room.closedAt = null; }
  }

  // ---------------------------------------------------------- room lookup

  /**
   * Org-scoped lookup with 404 concealment. A room belonging to another club is
   * indistinguishable from a room that does not exist — the response, the
   * status code and the body are identical.
   */
  function findRoom(req, res) {
    const c = db.recruitmentCases.find((x) => x.id === req.params.id && x.orgId === req.org.id && isRoom(x));
    if (!c) { res.status(404).json({ error: 'ROOM_NOT_FOUND' }); return null; }
    if (c.restricted && !roomRole({ room: c, user: req.orgUser, isLead: isLead(req.orgUser) })) {
      res.status(403).json({ error: 'ROOM_RESTRICTED', message: 'This room is restricted to its lead, its assignees and recruitment leads.' });
      return null;
    }
    return c;
  }

  const roleFor = (req, room) => roomRole({ room, user: req.orgUser, isLead: isLead(req.orgUser) });

  function requireCan(req, res, room, action) {
    const role = roleFor(req, room);
    if (!roomCan(role, action)) {
      res.status(403).json({ error: 'ROOM_PERMISSION_REQUIRED', message: 'Your role in this room does not allow that.', role, action });
      return false;
    }
    return true;
  }

  function activity(room, req, type, detail = null) {
    audit(room, 'org', req.orgUser.id, req.orgUser.name, type, detail);
  }

  // ------------------------------------------------------ source gathering

  /**
   * Everything the Room knows about a player comes from here, and every branch
   * is gated. When the player is not currently visible this returns
   * `{ visible: false }` and NOTHING else — no cached name, no stale Passport,
   * no last-known Trust Score.
   */
  function sources(room, org, { light = false } = {}) {
    const player = findPlayer(room.playerId);
    if (!player || !orgCanSee(org, player)) return { visible: false, player: null };

    const viewerKind = org.type === 'agency' ? 'agency'
      : org.level === 'grassroots' ? 'grassroots_club' : 'pro_club';

    // One light Passport assembly per player, shared with the Trust engine so
    // the batch path never assembles it twice.
    const full = ctx.assemblePassport?.(player, { light: true }) ?? null;
    const trustProfile = full && ctx.buildTrustProfile ? ctx.buildTrustProfile(player, { full }) : null;
    const trust = trustProfile ? ctx.safeTrustProjection(trustProfile, viewerKind) : null;

    if (light) return { visible: true, player, viewerKind, trust, trustProfile, full };

    const passport = ctx.buildFootballPassport?.(player, viewerKind, { orgId: org.id }) ?? null;

    // Combine obeys the identical dual consent rule M16.1 applies: the standing
    // gates AND (the player's recruitment opt-in OR this org's own request).
    const maySeeCombine = ctx.combineOrgMaySeeResults?.(org, player) ?? false;
    const combine = maySeeCombine ? (ctx.combineProjection?.(player.id) ?? null) : null;
    const combineRequests = db.combineRequests
      .filter((r) => r.orgId === org.id && r.playerId === player.id)
      .map((r) => ctx.combineRequestView?.(r) ?? r);

    // Development activity only behind the player's own recruitment share pref.
    const prefs = ctx.boxPrefsFor?.(player.id) ?? {};
    const development = prefs.shareDevelopmentActivity === 'recruitment'
      ? { ...(passport?.developmentActivity ?? {}), note: ROOM_DEV_NOTE }
      : { shared: false, note: 'This player has not shared development activity for recruitment.' };

    return { visible: true, player, viewerKind, trust, trustProfile, full, passport, combine, maySeeCombine, combineRequests, development };
  }

  // ------------------------------------------------------- room components

  const roomComments = (roomId) => db.roomComments.filter((c) => c.roomId === roomId);
  const roomDecisions = (roomId) => db.roomDecisions.filter((d) => d.roomId === roomId).sort((a, b) => a.createdAt - b.createdAt);
  const currentDecision = (roomId) => { const all = roomDecisions(roomId); return all.length ? all[all.length - 1] : null; };

  function commentView(c, { orgId }) {
    return {
      id: c.id,
      roomId: c.roomId,
      author: { userId: c.authorId, name: c.authorName },
      body: c.deletedAt ? null : c.body,
      deleted: !!c.deletedAt,
      // A deleted comment is tombstoned, never erased: the thread and the audit
      // trail stay intact and the author stays attributable.
      deletedAt: c.deletedAt ?? null,
      edited: !!c.editedAt,
      editedAt: c.editedAt ?? null,
      editCount: c.editCount ?? 0,
      replyToId: c.replyToId ?? null,
      mentions: (c.mentions ?? []).map((id) => ({ userId: id, name: orgUser(orgId, id)?.name ?? 'Former colleague' })),
      createdAt: c.createdAt,
    };
  }

  function taskView(t) {
    return {
      id: t.id, title: t.title, description: t.description ?? null,
      assigneeUserId: t.assigneeUserId ?? null, assigneeName: t.assigneeName ?? null,
      status: t.status, dueAt: t.dueAt ?? null,
      linkedResourceType: t.linkedResourceType ?? null, linkedResourceId: t.linkedResourceId ?? null,
      createdBy: t.createdBy ?? null, createdAt: t.createdAt,
      completedAt: t.completedAt ?? null,
    };
  }

  const openTaskCount = (room) => (room.tasks ?? []).filter((t) => ['open', 'in_progress'].includes(t.status ?? 'open')).length;

  function decisionView(d) {
    return {
      id: d.id, recommendation: d.recommendation, reasonCodes: d.reasonCodes,
      note: d.note, by: d.by, createdAt: d.createdAt,
      supersededById: d.supersededById ?? null,
      snapshot: d.snapshot ?? null,
    };
  }

  /** Assessments for this org only, through M12's existing blind-until-submit rule. */
  function assessmentsFor(req, room) {
    const mine = db.assessments.filter((a) => a.orgId === req.org.id && a.playerId === room.playerId);
    const lead = isLead(req.orgUser);
    const ownNonDraft = mine.some((a) => a.scoutUserId === req.orgUser.id && a.state !== 'draft');
    return mine
      // M13 calibration policy: a scout cannot read a peer's submitted
      // assessment until they have submitted their own. The Room surfaces
      // assessments; it does not become a way around that.
      .filter((a) => lead || a.scoutUserId === req.orgUser.id || (a.state !== 'draft' && ownNonDraft))
      .map((a) => ({
        id: a.id, scoutUserId: a.scoutUserId, scoutName: a.scoutName,
        templateId: a.templateId, templateVersion: a.templateVersion,
        state: a.state, recommendation: a.recommendation ?? null,
        context: a.context ?? null, createdAt: a.createdAt, submittedAt: a.submittedAt ?? null,
      }));
  }

  const blindWithheld = (req, room) => {
    const mine = db.assessments.filter((a) => a.orgId === req.org.id && a.playerId === room.playerId);
    const visible = assessmentsFor(req, room).length;
    return mine.length - visible;
  };

  /**
   * The org-visible evidence list, plus the Room's own private review state.
   *
   * The Passport's club projection deliberately returns `evidence` as a SUMMARY
   * object (`{fullMatches, clips, references, lastEvidenceDays, …}`), not a row
   * list — so the Room reads the canonical `db.evidence` rows itself and keeps
   * the summary for the header. Access is already settled: `sources()` returned
   * `visible: true`, which means `orgCanSee` passed on this read.
   */
  function evidenceFor(req, room, srcs) {
    const state = db.roomEvidenceState.filter((e) => e.roomId === room.id);
    const list = db.evidence
      .filter((e) => e.playerId === room.playerId && !e.supersededBy)
      .sort((a, b) => (b.recordedAt ?? 0) - (a.recordedAt ?? 0))
      .map((e) => ({
        id: e.id,
        claimType: e.claimType,
        label: e.label,
        value: e.value ?? null,
        units: e.units ?? null,
        season: e.season ?? null,
        // Provenance travels with every item — never flattened to a tick.
        provenance: e.verification?.status ?? 'self_reported',
        source: { kind: e.source?.kind ?? null, name: e.source?.name ?? null },
        recordedAt: e.recordedAt ?? null,
        observedAt: e.observedAt ?? null,
        // Counts only: the dispute reason is a conversation between the player
        // and Trust & Safety, and never reaches a recruiting club.
        openDisputes: (e.disputes ?? []).filter((d) => d.status === 'open').length,
      }));
    return list.map((e) => {
      const s = state.find((x) => x.evidenceId === e.id);
      return {
        ...e,
        review: {
          state: s?.state ?? 'not_reviewed',
          note: s?.note ?? null,
          by: s?.byName ?? null,
          at: s?.at ?? null,
        },
      };
    });
  }

  function missingEvidenceFor(req, room, srcs) {
    if (!srcs.visible || !ctx.computeEvidenceGaps) return [];
    return ctx.computeEvidenceGaps(req.org, srcs.player)
      .map((s) => ({ id: s.id, ruleId: s.ruleId, ruleVersion: s.ruleVersion, explanation: s.explanation, action: s.action, status: s.status, requestedAt: s.requestedAt }))
      .sort((a, b) => String(a.ruleId).localeCompare(String(b.ruleId)));
  }

  function trialsFor(req, room) {
    return db.trials
      .filter((t) => t.orgId === req.org.id && t.playerId === room.playerId)
      .map((t) => ({
        id: t.id, status: t.status, proposedDate: t.proposedDate ?? null,
        venue: t.venue ?? null, reportDueAt: t.reportDueAt ?? null,
        hasReport: !!t.report, linked: (room.links?.trialIds ?? []).includes(t.id),
      }));
  }

  const trialStateFor = (trials) => {
    if (trials.some((t) => t.status === 'reported')) return 'reported';
    if (trials.some((t) => t.status === 'awaiting_report')) return 'awaiting_report';
    return 'none';
  };

  function readinessFor(req, room, srcs, extra) {
    const assessments = extra.assessments;
    const evidence = extra.evidence;
    const recentFullMatch = evidence.some((e) => e.claimType === 'footage' && e.recordedAt && e.recordedAt > now() - 180 * 86_400_000);
    const coachReference = evidence.some((e) => e.provenance === 'coach_confirmed')
      || (srcs.passport?.references ?? []).some((r) => r.provenance && String(r.provenance).includes('coach'));
    return decisionReadiness({
      assessmentsAssigned: (room.assignments ?? []).filter((a) => /assess/i.test(a.task ?? '')).length || assessments.length,
      assessmentsSubmitted: assessments.filter((a) => a.state !== 'draft').length,
      recentFullMatch,
      coachReference,
      combineVerified: (srcs.combine?.results ?? []).length,
      combineRequested: (srcs.combineRequests ?? []).filter((r) => r.state === 'requested').length,
      trialState: extra.trialState,
      openTasks: openTaskCount(room),
      openEvidenceRequests: extra.missingEvidence.filter((m) => m.status === 'requested').length,
    });
  }

  // ---------------------------------------------------------- THE PROJECTOR

  /**
   * `buildRecruitmentRoom` is the one place a Room is assembled. The client
   * never joins source endpoints itself — every branch below has already been
   * through the gate that owns it.
   */
  function buildRecruitmentRoom(room, req) {
    const org = req.org;
    const srcs = sources(room, org);
    const role = roleFor(req, room);

    const base = {
      roomId: room.id,
      orgId: room.orgId,
      playerId: room.playerId,
      status: room.room.status,
      statusLabel: ROOM_STATUS_LABELS[room.room.status],
      allowedTransitions: ROOM_TRANSITIONS[room.room.status] ?? [],
      stage: room.stage,
      priority: room.room.priority,
      priorityNote: ROOM_PRIORITY_NOTE,
      tags: room.room.tags ?? [],
      restricted: !!room.restricted,
      sourceContext: room.room.sourceContext,
      owner: { userId: room.ownerUserId, name: room.ownerName },
      leadScout: room.room.leadScoutUserId
        ? { userId: room.room.leadScoutUserId, name: orgUser(org.id, room.room.leadScoutUserId)?.name ?? 'Former colleague' }
        : null,
      viewerRole: role,
      createdAt: room.createdAt,
      updatedAt: room.room.updatedAt,
      archivedAt: room.room.archivedAt ?? null,
      closedAt: room.room.closedAt ?? null,
      links: room.links,
      privacyNote: ROOM_PRIVACY_NOTE,
    };

    // Internal work is always available — it belongs to the club, not to the
    // player record. Player projections are not.
    const tasks = (room.tasks ?? []).map(taskView);
    const comments = roomComments(room.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, LIMITS.pageSize).map((c) => commentView(c, { orgId: org.id }));
    const decisions = roomDecisions(room.id).map(decisionView);
    const current = decisions.length ? decisions[decisions.length - 1] : null;

    if (!srcs.visible) {
      return {
        ...base,
        playerAvailable: false,
        playerName: null,
        player: null,
        unavailableNote: ROOM_UNAVAILABLE_NOTE,
        trust: null, passport: null, evidence: [], assessments: [], combine: null,
        development: null, missingEvidence: [], trials: [],
        tasks, comments, decision: { current, history: decisions },
        activity: roomActivity(room.history ?? []),
        readiness: null, health: null, healthLabel: null,
      };
    }

    const assessments = assessmentsFor(req, room);
    const evidence = evidenceFor(req, room, srcs);
    const missingEvidence = missingEvidenceFor(req, room, srcs);
    const trials = trialsFor(req, room);
    const trialState = trialStateFor(trials);
    const readiness = readinessFor(req, room, srcs, { assessments, evidence, missingEvidence, trialState });
    const health = roomHealth({ readiness, hasCurrentDecision: !!current, status: room.room.status });

    return {
      ...base,
      playerAvailable: true,
      playerName: srcs.player.name,
      player: roomPlayerView(srcs.player, org),
      trust: srcs.trust ? { ...srcs.trust, note: ROOM_TRUST_NOTE } : null,
      passport: srcs.passport,
      evidence,
      assessments,
      assessmentsWithheldPendingOwnSubmission: blindWithheld(req, room),
      combine: srcs.maySeeCombine
        ? { ...(srcs.combine ?? {}), requests: srcs.combineRequests, shared: true }
        : { results: [], shared: false, requests: srcs.combineRequests, note: 'This player has not shared Combine results with your organisation.' },
      development: srcs.development,
      missingEvidence,
      trials,
      tasks,
      comments,
      decision: { current, history: decisions },
      activity: roomActivity(room.history ?? []),
      readiness,
      health,
      healthLabel: ROOM_HEALTH_LABELS[health],
    };
  }
  ctx.buildRecruitmentRoom = buildRecruitmentRoom;

  // ================================================================= ROUTES

  // ------------------------------------------------------------- room list

  orgRouter.get('/rooms', (req, res) => {
    const all = db.recruitmentCases.filter((c) => c.orgId === req.org.id && isRoom(c));
    const mine = all.filter((c) => !c.restricted || roomRole({ room: c, user: req.orgUser, isLead: isLead(req.orgUser) }));

    let list = mine;
    const view = String(req.query.view ?? 'all');
    if (view === 'mine') list = list.filter((c) => c.ownerUserId === req.orgUser.id || c.room.leadScoutUserId === req.orgUser.id);
    if (view === 'assigned') list = list.filter((c) => (c.assignments ?? []).some((a) => a.userId === req.orgUser.id) || (c.tasks ?? []).some((t) => t.assigneeUserId === req.orgUser.id && ['open', 'in_progress'].includes(t.status)));
    if (view === 'shortlisted') list = list.filter((c) => ['shortlisted', 'priority'].includes(c.room.status));
    if (view === 'trials') list = list.filter((c) => ['trial_requested', 'trial_scheduled', 'trial_completed'].includes(c.room.status));
    if (view === 'offers') list = list.filter((c) => ['offer_consideration', 'offer_made'].includes(c.room.status));
    if (view === 'archived') list = list.filter((c) => ['archived', 'closed', 'withdrawn'].includes(c.room.status));
    if (view === 'active') list = list.filter((c) => OPEN_ROOM_STATUSES.includes(c.room.status));
    if (req.query.status) list = list.filter((c) => c.room.status === String(req.query.status));
    if (req.query.tag) list = list.filter((c) => (c.room.tags ?? []).includes(String(req.query.tag)));
    if (req.query.assignee) list = list.filter((c) => (c.tasks ?? []).some((t) => t.assigneeUserId === String(req.query.assignee)) || c.room.leadScoutUserId === String(req.query.assignee) || c.ownerUserId === String(req.query.assignee));

    const q = String(req.query.q ?? '').trim().toLowerCase();
    if (q) {
      list = list.filter((c) => {
        const p = findPlayer(c.playerId);
        const visible = p && orgCanSee(req.org, p);
        return (visible && c.playerName.toLowerCase().includes(q))
          || (c.room.tags ?? []).some((t) => t.toLowerCase().includes(q))
          || ROOM_STATUS_LABELS[c.room.status].toLowerCase().includes(q);
      });
    }

    const limit = clampPage(req.query.limit);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const sorted = list.slice().sort((a, b) => (b.room.updatedAt - a.room.updatedAt) || String(a.id).localeCompare(String(b.id)));
    const page = sorted.slice(offset, offset + limit);

    // One light assembly per player on the page, shared between the Passport
    // and Trust engines — no per-row source round trip.
    const items = page.map((c) => {
      const srcs = sources(c, req.org, { light: true });
      const readiness = null;
      return roomSummary(c, {
        player: srcs.visible ? playerViewForOrg(srcs.player, req.org) : null,
        trust: srcs.trust,
        openTasks: openTaskCount(c),
        health: roomHealth({ readiness, hasCurrentDecision: !!currentDecision(c.id), status: c.room.status }),
        lastActivityAt: (c.history ?? []).reduce((m, h) => Math.max(m, h.at ?? 0), c.createdAt),
        visible: srcs.visible,
      });
    });

    res.json({
      items, total: sorted.length, limit, offset,
      funnel: roomFunnel(mine),
      statuses: ROOM_STATUSES.map((s) => ({ id: s, label: ROOM_STATUS_LABELS[s] })),
      note: 'Rooms are listed by most recent activity. ScoutBox never orders players by Trust Score.',
    });
  });

  /** Needs-attention: deterministic, no priority scoring of any kind. */
  orgRouter.get('/rooms/needs-attention', (req, res) => {
    const mine = db.recruitmentCases.filter((c) => c.orgId === req.org.id && isRoom(c)
      && (!c.restricted || roomRole({ room: c, user: req.orgUser, isLead: isLead(req.orgUser) }))
      && OPEN_ROOM_STATUSES.includes(c.room.status));
    const items = [];
    for (const c of mine) {
      const reasons = [];
      const overdue = (c.tasks ?? []).filter((t) => ['open', 'in_progress'].includes(t.status) && t.dueAt && t.dueAt < now());
      if (overdue.length) reasons.push({ code: 'TASK_OVERDUE', text: `${overdue.length} task(s) past their due date.` });
      const supplied = db.evidenceSuggestions.filter((s) => s.orgId === req.org.id && s.playerId === c.playerId && s.status === 'supplied');
      if (supplied.length) reasons.push({ code: 'EVIDENCE_RETURNED', text: 'Requested evidence has arrived.' });
      const doneCombine = db.combineRequests.filter((r) => r.orgId === req.org.id && r.playerId === c.playerId && r.state === 'completed');
      if (doneCombine.length) reasons.push({ code: 'COMBINE_COMPLETED', text: 'A requested Combine has been completed.' });
      const reported = db.trials.filter((t) => t.orgId === req.org.id && t.playerId === c.playerId && t.status === 'reported');
      if (reported.length && c.room.status === 'trial_scheduled') reasons.push({ code: 'TRIAL_REPORTED', text: 'A trial report is in.' });
      if (['offer_consideration', 'offer_made'].includes(c.room.status) && !currentDecision(c.id)) reasons.push({ code: 'DECISION_OUTSTANDING', text: 'No decision has been recorded yet.' });
      if (reasons.length) items.push({ roomId: c.id, playerId: c.playerId, playerName: c.playerName, status: c.room.status, reasons });
    }
    res.json({ items, note: 'Deterministic workflow signals only. ScoutBox does not rank or score these for you.' });
  });

  /** Which of these players already have a room? Used by the search screen. */
  orgRouter.get('/rooms/summaries', (req, res) => {
    const ids = String(req.query.playerIds ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    const items = ids.map((pid) => {
      const c = db.recruitmentCases.find((x) => x.orgId === req.org.id && x.playerId === pid && isRoom(x) && OPEN_ROOM_STATUSES.includes(x.room.status));
      if (!c || (c.restricted && !roomRole({ room: c, user: req.orgUser, isLead: isLead(req.orgUser) }))) return { playerId: pid, roomId: null, status: null };
      return { playerId: pid, roomId: c.id, status: c.room.status, statusLabel: ROOM_STATUS_LABELS[c.room.status] };
    });
    res.json({ items });
  });

  // ----------------------------------------------------------- create room

  orgRouter.post('/rooms', (req, res) => {
    if (limited(`room:create:${req.org.id}`, LIMITS.roomsPerOrgPerHour, 3_600_000)) {
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many rooms created in the last hour.' });
    }
    const { playerId, sourceContext, priority, restricted, vacancyId } = req.body ?? {};
    const p = findPlayer(playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    // A room cannot be used to bookmark a player the club may not see.
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE', message: 'This player is not visible to your organisation under the standing rules.' });
    if (vacancyId && !db.vacancies.some((v) => v.id === vacancyId && v.orgId === req.org.id)) return res.status(404).json({ error: 'VACANCY_NOT_FOUND' });

    const existing = db.recruitmentCases.find((c) => c.orgId === req.org.id && c.playerId === p.id && isRoom(c) && OPEN_ROOM_STATUSES.includes(c.room.status));
    if (existing) {
      return res.status(409).json({
        error: 'ROOM_EXISTS', existingRoomId: existing.id, status: existing.room.status,
        message: 'Your organisation already has an active Recruitment Room for this player.',
      });
    }

    // Adopt this org's open case for the player if one exists — a Room is a
    // facet of the case, so a club never ends up with a case and a room that
    // disagree about where the player is in the pipeline.
    let room = db.recruitmentCases.find((c) => c.orgId === req.org.id && c.playerId === p.id && c.stage !== 'closed' && !isRoom(c));
    const adopted = !!room;
    if (!room) {
      room = {
        id: nextId('case'), orgId: req.org.id, playerId: p.id, playerName: p.name,
        vacancyId: vacancyId ?? null, ownerUserId: req.orgUser.id, ownerName: req.orgUser.name,
        stage: null, priority: 'medium', deadline: null, restricted: !!restricted,
        assignments: [], tasks: [], approvals: [], decision: null,
        links: { requestIds: [], trialIds: [], signingId: null },
        createdAt: now(), history: [],
      };
      db.recruitmentCases.push(room);
    }
    room.room = {
      status: 'watching',
      priority: ROOM_PRIORITIES.includes(priority) ? priority : 'normal',
      tags: [],
      leadScoutUserId: req.orgUser.id,
      sourceContext: normaliseSourceContext(sourceContext),
      openedBy: { userId: req.orgUser.id, name: req.orgUser.name },
      updatedAt: now(), archivedAt: null, closedAt: null,
    };
    if (adopted && room.stage) {
      // The case already had a stage — keep its meaning rather than resetting
      // the club's pipeline position to the start.
      room.room.status = roomStatusForStage(room.stage, req.org.level) ?? 'watching';
    }
    applyStatus(room, room.room.status, req.org);
    activity(room, req, 'room_created', { status: room.room.status, sourceContext: room.room.sourceContext, adoptedExistingCase: adopted });
    vmetric('recruitment_room_created');
    ledgerAppend?.({ type: 'recruitment_room_created', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    persistNow();
    res.status(201).json({ room: buildRecruitmentRoom(room, req), adoptedExistingCase: adopted });
  });

  // -------------------------------------------------------------- get room

  orgRouter.get('/rooms/:id', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    res.json({ room: buildRecruitmentRoom(room, req) });
  });

  orgRouter.patch('/rooms/:id', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    const { priority, tags, leadScoutUserId, ownerUserId, restricted, deadline } = req.body ?? {};

    if (priority !== undefined) {
      if (!ROOM_PRIORITIES.includes(priority)) return res.status(400).json({ error: 'ROOM_PRIORITY_UNKNOWN' });
      if (!requireCan(req, res, room, 'set_status')) return;
      room.room.priority = priority;
      activity(room, req, 'room_priority_changed', { priority });
    }
    if (tags !== undefined) {
      if (!Array.isArray(tags)) return res.status(400).json({ error: 'ROOM_TAGS_INVALID' });
      if (tags.length > LIMITS.tagsPerRoom) return res.status(400).json({ error: 'ROOM_TAGS_TOO_MANY' });
      const out = [];
      for (const raw of tags) {
        const v = validateTag(raw);
        if (!v.ok) return res.status(400).json(v);
        out.push(v.tag);
      }
      room.room.tags = [...new Set(out)];
      activity(room, req, 'room_tag_changed', { count: room.room.tags.length });
    }
    if (leadScoutUserId !== undefined) {
      if (!requireCan(req, res, room, 'assign')) return;
      if (leadScoutUserId !== null && !orgUser(req.org.id, leadScoutUserId)) return res.status(404).json({ error: 'USER_NOT_IN_ORG' });
      room.room.leadScoutUserId = leadScoutUserId;
      activity(room, req, 'room_member_assigned', { leadScoutUserId });
    }
    if (ownerUserId !== undefined) {
      // A departed owner must never leave a room unusable: any recruitment
      // lead can reassign it, not only the owner.
      if (!requireCan(req, res, room, 'reassign_owner')) return;
      const u = orgUser(req.org.id, ownerUserId);
      if (!u) return res.status(404).json({ error: 'USER_NOT_IN_ORG' });
      room.ownerUserId = u.id;
      room.ownerName = u.name;
      activity(room, req, 'room_owner_changed', { ownerUserId: u.id });
    }
    if (restricted !== undefined) {
      if (!requireCan(req, res, room, 'set_status')) return;
      room.restricted = !!restricted;
    }
    if (deadline !== undefined) room.deadline = deadline ?? null;

    room.room.updatedAt = now();
    persistNow();
    res.json({ room: buildRecruitmentRoom(room, req) });
  });

  // ----------------------------------------------------------- status move

  orgRouter.post('/rooms/:id/status', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    if (!requireCan(req, res, room, 'set_status')) return;

    const to = String(req.body?.status ?? '');
    const reasons = validateReasonCodes(req.body?.reasonCodes ?? []);
    if (!reasons.ok) return res.status(400).json(reasons);
    const note = req.body?.note == null ? null : plainText(req.body.note, 2000);
    if (note && !moderateOrRefuse(res, note, { kind: 'recruitment_room', orgId: req.org.id })) return;

    const check = validateTransition(room.room.status, to, { reasonCodes: reasons.codes });
    if (!check.ok) return res.status(check.error === 'ROOM_TRANSITION_INVALID' ? 409 : 400).json(check);

    const from = room.room.status;
    applyStatus(room, to, req.org);

    // Snapshot the evidence confidence the club could see AT this moment.
    let snapshot = null;
    if (check.snapshot) snapshot = captureSnapshot(room, req, `status:${to}`);

    if (check.reopen) {
      room.room.reopened = { by: { userId: req.orgUser.id, name: req.orgUser.name }, at: now(), from, reasonCodes: reasons.codes };
      activity(room, req, 'room_reopened', { from, to, reasonCodes: reasons.codes });
      vmetric('recruitment_room_reopened');
    }
    activity(room, req, 'room_status_changed', { from, to, reasonCodes: reasons.codes, note: note ? true : false });
    vmetric('recruitment_room_status_changed');
    if (to === 'archived' || to === 'closed' || to === 'withdrawn') vmetric('recruitment_room_archived');
    if (to === 'signed') vmetric('recruitment_room_signed');

    // A status that ends pursuit records a decision so the reason survives as
    // machine-readable decision memory, not as a status flag alone.
    if (['archived', 'closed', 'withdrawn'].includes(to)) {
      recordDecision(room, req, {
        recommendation: to === 'signed' ? 'offer' : 'archive',
        reasonCodes: reasons.codes,
        note,
        snapshot,
        trigger: `status:${to}`,
      });
      // Keep M12's sign-off artefact consistent so "closing needs a decision"
      // stays true without a second decision store fighting this one.
      room.decision = { outcome: 'pass', reasons: reasons.codes.join(', '), byUserId: req.orgUser.id, byName: req.orgUser.name, at: now() };
    }
    if (to === 'signed') {
      room.decision = { outcome: 'sign', reasons: reasons.codes.join(', ') || 'signed', byUserId: req.orgUser.id, byName: req.orgUser.name, at: now() };
    }

    for (const u of orgUsers(req.org.id)) {
      if (u.id === req.orgUser.id) continue;
      if (u.id === room.ownerUserId || u.id === room.room.leadScoutUserId) {
        notify({ kind: 'org_user', id: u.id }, 'recruitment_room', `Recruitment Room — ${room.playerName}: ${ROOM_STATUS_LABELS[to]}.`, room.id);
      }
    }
    persistNow();
    res.json({ room: buildRecruitmentRoom(room, req), snapshot });
  });

  /**
   * The ONE reopen path, shared with M18 Second Look.
   *
   * A Second Look never reopens a room by itself — a recruiter does, and when
   * they do, the move runs through exactly this code: the same transition
   * table, the same reason requirement, the same snapshot capture, the same
   * append-only decision memory and the same activity trail. M18 supplies only
   * the source context so the reopen is attributable later.
   */
  ctx.reopenRoom = ({ req, room, to = 'under_review', reasonCodes = [], sourceContext = null, sourceRef = null }) => {
    const role = roleFor(req, room);
    if (!roomCan(role, 'reopen')) return { ok: false, status: 403, error: 'ROOM_PERMISSION_REQUIRED' };
    const reasons = validateReasonCodes(reasonCodes);
    if (!reasons.ok) return { ok: false, status: 400, ...reasons };
    const check = validateTransition(room.room.status, to, { reasonCodes: reasons.codes });
    if (!check.ok) return { ok: false, status: check.error === 'ROOM_TRANSITION_INVALID' ? 409 : 400, ...check };

    const from = room.room.status;
    applyStatus(room, to, req.org);
    if (check.snapshot) captureSnapshot(room, req, `status:${to}`);
    room.room.reopened = {
      by: { userId: req.orgUser.id, name: req.orgUser.name }, at: now(), from,
      reasonCodes: reasons.codes, sourceContext, sourceRef,
    };
    if (sourceContext) room.room.sourceContext = sourceContext;
    activity(room, req, 'room_reopened', { from, to, reasonCodes: reasons.codes, sourceContext, sourceRef });
    vmetric('recruitment_room_reopened');
    persistNow();
    return { ok: true, room: buildRecruitmentRoom(room, req), from, to };
  };
  ctx.findRoomForRequest = findRoom;
  ctx.roomIsRoom = isRoom;

  /**
   * The ONE room creator reachable from another milestone, shared with M18
   * Nobody Missed. A candidate added from a brief gets a room through exactly
   * the same path as one added from Discover: the same visibility check, the
   * same uniqueness rule, the same adoption of an existing case. M18 supplies
   * only the source context, so the funnel can later distinguish a room opened
   * from a brief from one opened organically.
   */
  ctx.createRoomForPlayer = ({ req, player, sourceContext = 'direct', sourceRef = null }) => {
    if (!orgCanSee(req.org, player)) return { ok: false, status: 403, error: 'NOT_VISIBLE' };
    const existing = db.recruitmentCases.find((c) => c.orgId === req.org.id && c.playerId === player.id
      && isRoom(c) && OPEN_ROOM_STATUSES.includes(c.room.status));
    if (existing) return { ok: true, roomId: existing.id, existed: true, room: buildRecruitmentRoom(existing, req) };

    let room = db.recruitmentCases.find((c) => c.orgId === req.org.id && c.playerId === player.id && c.stage !== 'closed' && !isRoom(c));
    const adopted = !!room;
    if (!room) {
      room = {
        id: nextId('case'), orgId: req.org.id, playerId: player.id, playerName: player.name,
        vacancyId: null, ownerUserId: req.orgUser.id, ownerName: req.orgUser.name,
        stage: null, priority: 'medium', deadline: null, restricted: false,
        assignments: [], tasks: [], approvals: [], decision: null,
        links: { requestIds: [], trialIds: [], signingId: null },
        createdAt: now(), history: [],
      };
      db.recruitmentCases.push(room);
    }
    room.room = {
      status: 'watching', priority: 'normal', tags: [], leadScoutUserId: req.orgUser.id,
      sourceContext: normaliseSourceContext(sourceContext), sourceRef,
      openedBy: { userId: req.orgUser.id, name: req.orgUser.name },
      updatedAt: now(), archivedAt: null, closedAt: null,
    };
    if (adopted && room.stage) room.room.status = roomStatusForStage(room.stage, req.org.level) ?? 'watching';
    applyStatus(room, room.room.status, req.org);
    activity(room, req, 'room_created', { status: room.room.status, sourceContext: room.room.sourceContext, sourceRef, adoptedExistingCase: adopted });
    vmetric('recruitment_room_created');
    ledgerAppend?.({ type: 'recruitment_room_created', playerId: player.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
    persistNow();
    return { ok: true, roomId: room.id, existed: false, room: buildRecruitmentRoom(room, req) };
  };

  // ------------------------------------------------------------- snapshots

  function captureSnapshot(room, req, trigger) {
    const srcs = sources(room, req.org, { light: true });
    if (!srcs.visible || !srcs.trustProfile) return null;
    const trust = ctx.trustSnapshotOf?.(srcs.trustProfile) ?? null;
    const full = srcs.full;
    const snap = {
      id: nextId('rsnap'),
      roomId: room.id, orgId: room.orgId, playerId: room.playerId,
      ...buildRoomSnapshot({
        trustSnapshot: trust,
        trigger,
        sourceRefs: {
          passportVersion: full?.passportVersion ?? null,
          evidenceIds: (db.evidence.filter((e) => e.playerId === room.playerId && !e.supersededBy).map((e) => e.id)),
          assessmentIds: db.assessments.filter((a) => a.orgId === room.orgId && a.playerId === room.playerId && a.state !== 'draft').map((a) => a.id),
          // Protocol coverage at decision time — which standardized tests had a
          // verified result, never the measured values themselves.
          combineResults: (ctx.combineProjection?.(room.playerId)?.results ?? [])
            .map((r) => `${r.protocolId}@${r.protocolVersion}`),
          trialIds: (room.links?.trialIds ?? []),
        },
      }),
    };
    db.roomSnapshots.push(snap);
    return snap;
  }

  orgRouter.get('/rooms/:id/snapshots', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    res.json({ items: db.roomSnapshots.filter((s) => s.roomId === room.id).sort((a, b) => b.at - a.at) });
  });

  // -------------------------------------------------------------- activity

  orgRouter.get('/rooms/:id/activity', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    res.json(roomActivity(room.history ?? [], { limit: clampPage(req.query.limit), cursor: req.query.cursor ?? null }));
  });

  // -------------------------------------------------------------- comments

  orgRouter.get('/rooms/:id/comments', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    const limit = clampPage(req.query.limit);
    const all = roomComments(room.id).sort((a, b) => (b.createdAt - a.createdAt) || String(b.id).localeCompare(String(a.id)));
    const start = req.query.cursor ? all.findIndex((c) => c.id === String(req.query.cursor)) + 1 : 0;
    const page = all.slice(start, start + limit);
    res.json({
      items: page.map((c) => commentView(c, { orgId: req.org.id })),
      nextCursor: start + limit < all.length ? page[page.length - 1]?.id ?? null : null,
      total: all.length,
      note: ROOM_PRIVACY_NOTE,
    });
  });

  orgRouter.post('/rooms/:id/comments', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    if (!requireCan(req, res, room, 'comment')) return;
    if (limited(`room:comment:${room.id}:${req.orgUser.id}`, LIMITS.commentsPerRoomPerMinute, 60_000)) {
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'Slow down a moment.' });
    }
    const body = plainText(req.body?.body, LIMITS.commentBody);
    if (!body) return res.status(400).json({ error: 'ROOM_COMMENT_EMPTY' });
    if (!moderateOrRefuse(res, body, { kind: 'recruitment_room_comment', orgId: req.org.id })) return;

    const replyToId = req.body?.replyToId ? String(req.body.replyToId) : null;
    if (replyToId) {
      // A comment id from another room is a 404 here, not a cross-room reply.
      const parent = db.roomComments.find((c) => c.id === replyToId && c.roomId === room.id);
      if (!parent) return res.status(404).json({ error: 'ROOM_COMMENT_NOT_FOUND' });
    }
    const mentions = [...new Set((Array.isArray(req.body?.mentions) ? req.body.mentions : []).map(String))]
      .filter((uid) => orgUser(req.org.id, uid))
      .slice(0, LIMITS.mentionsPerComment);

    const c = {
      id: nextId('rcmt'), roomId: room.id, orgId: req.org.id,
      authorId: req.orgUser.id, authorName: req.orgUser.name,
      body, replyToId, mentions,
      createdAt: now(), editedAt: null, editCount: 0, deletedAt: null,
    };
    db.roomComments.push(c);
    activity(room, req, 'room_comment_added', { commentId: c.id, replyToId });
    room.room.updatedAt = now();
    vmetric('room_comment_added');
    // Internal only: a mention notifies a colleague in this organisation and
    // nobody else. No player, guardian, coach, other club or email.
    for (const uid of mentions) {
      if (uid === req.orgUser.id) continue;
      notify({ kind: 'org_user', id: uid }, 'recruitment_room', `${req.orgUser.name} mentioned you in the Recruitment Room for ${room.playerName}.`, room.id);
    }
    persistNow();
    res.status(201).json({ comment: commentView(c, { orgId: req.org.id }) });
  });

  orgRouter.patch('/rooms/:id/comments/:cid', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    const c = db.roomComments.find((x) => x.id === req.params.cid && x.roomId === room.id);
    if (!c) return res.status(404).json({ error: 'ROOM_COMMENT_NOT_FOUND' });
    if (c.authorId !== req.orgUser.id) return res.status(403).json({ error: 'ROOM_COMMENT_NOT_AUTHOR', message: 'Only the author can edit a comment.' });
    if (c.deletedAt) return res.status(409).json({ error: 'ROOM_COMMENT_DELETED' });
    const body = plainText(req.body?.body, LIMITS.commentBody);
    if (!body) return res.status(400).json({ error: 'ROOM_COMMENT_EMPTY' });
    if (!moderateOrRefuse(res, body, { kind: 'recruitment_room_comment', orgId: req.org.id })) return;
    c.body = body;
    c.editedAt = now();
    c.editCount = (c.editCount ?? 0) + 1;
    activity(room, req, 'room_comment_edited', { commentId: c.id });
    persistNow();
    res.json({ comment: commentView(c, { orgId: req.org.id }) });
  });

  orgRouter.delete('/rooms/:id/comments/:cid', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    const c = db.roomComments.find((x) => x.id === req.params.cid && x.roomId === room.id);
    if (!c) return res.status(404).json({ error: 'ROOM_COMMENT_NOT_FOUND' });
    const lead = isLead(req.orgUser);
    if (c.authorId !== req.orgUser.id && !lead) return res.status(403).json({ error: 'ROOM_COMMENT_NOT_AUTHOR' });
    // Tombstone, never erase: the thread keeps its shape and the audit trail
    // keeps its attribution.
    c.deletedAt = now();
    c.deletedBy = { userId: req.orgUser.id, name: req.orgUser.name };
    activity(room, req, 'room_comment_deleted', { commentId: c.id });
    persistNow();
    res.json({ comment: commentView(c, { orgId: req.org.id }) });
  });

  // ----------------------------------------------------------------- tasks

  orgRouter.post('/rooms/:id/tasks', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    if (!requireCan(req, res, room, 'create_task')) return;
    if ((room.tasks ?? []).length >= LIMITS.tasksPerRoom) return res.status(409).json({ error: 'ROOM_TASKS_FULL' });
    const title = plainText(req.body?.title, LIMITS.taskTitle);
    if (!title) return res.status(400).json({ error: 'ROOM_TASK_TITLE_REQUIRED' });
    if (!moderateOrRefuse(res, title, { kind: 'recruitment_room_task', orgId: req.org.id })) return;
    const description = req.body?.description ? plainText(req.body.description, LIMITS.taskDescription) : null;

    let assignee = null;
    if (req.body?.assigneeUserId) {
      assignee = orgUser(req.org.id, String(req.body.assigneeUserId));
      // A task can only be given to someone in this organisation.
      if (!assignee) return res.status(404).json({ error: 'USER_NOT_IN_ORG' });
    }
    const linkedResourceType = LINKED_RESOURCE_TYPES.includes(req.body?.linkedResourceType) ? req.body.linkedResourceType : null;

    const t = {
      id: nextId('tsk'), title, description,
      assigneeUserId: assignee?.id ?? null, assigneeName: assignee?.name ?? null,
      status: 'open', dueAt: req.body?.dueAt ?? null,
      linkedResourceType, linkedResourceId: linkedResourceType ? String(req.body?.linkedResourceId ?? '') || null : null,
      createdBy: { userId: req.orgUser.id, name: req.orgUser.name },
      createdAt: now(), completedAt: null,
    };
    room.tasks ??= [];
    room.tasks.push(t);
    room.room.updatedAt = now();
    activity(room, req, 'room_task_created', { taskId: t.id, assigneeUserId: t.assigneeUserId });
    vmetric('room_task_created');
    // A room task is STAFF work. It is never sent to the player: a player-facing
    // ask must go through the evidence-request or Combine-request workflow.
    if (assignee && assignee.id !== req.orgUser.id) {
      notify({ kind: 'org_user', id: assignee.id }, 'recruitment_room', `${req.orgUser.name} assigned you a task in the Recruitment Room for ${room.playerName}: ${title}`, room.id);
    }
    persistNow();
    res.status(201).json({ task: taskView(t) });
  });

  orgRouter.patch('/rooms/:id/tasks/:tid', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    const t = (room.tasks ?? []).find((x) => x.id === req.params.tid);
    if (!t) return res.status(404).json({ error: 'ROOM_TASK_NOT_FOUND' });
    const role = roleFor(req, room);
    const mine = t.assigneeUserId === req.orgUser.id || t.createdBy?.userId === req.orgUser.id;
    if (!mine && !roomCan(role, 'assign')) return res.status(403).json({ error: 'ROOM_PERMISSION_REQUIRED', message: 'Only the assignee, the creator or a room lead can change this task.' });

    if (req.body?.status !== undefined) {
      const to = String(req.body.status);
      if (!TASK_STATES.includes(to)) return res.status(400).json({ error: 'ROOM_TASK_STATE_UNKNOWN' });
      const from = t.status ?? 'open';
      if (from !== to && !canTaskTransition(from, to)) return res.status(409).json({ error: 'ROOM_TASK_TRANSITION_INVALID', from, to });
      t.status = to;
      t.completedAt = to === 'done' ? now() : null;
    }
    if (req.body?.assigneeUserId !== undefined) {
      if (!roomCan(role, 'assign')) return res.status(403).json({ error: 'ROOM_PERMISSION_REQUIRED' });
      if (req.body.assigneeUserId === null) { t.assigneeUserId = null; t.assigneeName = null; }
      else {
        const u = orgUser(req.org.id, String(req.body.assigneeUserId));
        if (!u) return res.status(404).json({ error: 'USER_NOT_IN_ORG' });
        t.assigneeUserId = u.id; t.assigneeName = u.name;
      }
    }
    room.room.updatedAt = now();
    activity(room, req, 'room_task_updated', { taskId: t.id, status: t.status });
    persistNow();
    res.json({ task: taskView(t) });
  });

  // ------------------------------------------------------------- decisions

  function recordDecision(room, req, { recommendation, reasonCodes, note, snapshot, trigger, clientKey = null }) {
    const prev = currentDecision(room.id);
    const d = {
      id: nextId('rdec'), roomId: room.id, orgId: room.orgId, playerId: room.playerId,
      recommendation, reasonCodes, note,
      by: { userId: req.orgUser.id, name: req.orgUser.name, role: req.orgUser.role ?? null },
      createdAt: now(), trigger: trigger ?? 'decision', clientKey,
      supersedes: prev?.id ?? null, supersededById: null,
      snapshot: snapshot ? { at: snapshot.at, trust: snapshot.trust, sourceRefs: snapshot.sourceRefs, snapshotId: snapshot.id } : null,
    };
    // Append-only: a revision SUPERSEDES its predecessor, it never rewrites it.
    if (prev) prev.supersededById = d.id;
    db.roomDecisions.push(d);
    activity(room, req, 'room_decision_recorded', { decisionId: d.id, recommendation, reasonCodes });
    vmetric('room_decision_recorded');
    if (['archived', 'closed', 'withdrawn'].includes(room.room.status)) {
      // The Second Look contract: a typed, machine-readable domain event with
      // reason CODES and no private free text.
      broadcast?.('recruitment_room_archived', secondLookEvent(room, d));
    }
    return d;
  }

  orgRouter.post('/rooms/:id/decisions', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    if (!requireCan(req, res, room, 'record_decision')) return;

    const clientKey = req.body?.clientKey ? String(req.body.clientKey).slice(0, 64) : null;
    if (clientKey) {
      const dup = db.roomDecisions.find((d) => d.roomId === room.id && d.clientKey === clientKey);
      // Idempotent submit: the same key returns the same decision instead of
      // stacking a duplicate onto the decision memory.
      if (dup) return res.status(200).json({ decision: decisionView(dup), idempotent: true });
    }
    const check = validateDecision({
      recommendation: req.body?.recommendation,
      reasonCodes: req.body?.reasonCodes ?? [],
      note: req.body?.note ?? null,
    });
    if (!check.ok) return res.status(400).json(check);
    const note = check.note == null ? null : plainText(check.note, 2000);
    if (note && !moderateOrRefuse(res, note, { kind: 'recruitment_room_decision', orgId: req.org.id })) return;

    const snapshot = captureSnapshot(room, req, 'decision');
    const d = recordDecision(room, req, { recommendation: check.recommendation, reasonCodes: check.codes, note, snapshot, trigger: 'decision', clientKey });
    room.room.updatedAt = now();
    persistNow();
    res.status(201).json({ decision: decisionView(d), snapshot });
  });

  orgRouter.get('/rooms/:id/decisions', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    const history = roomDecisions(room.id).map(decisionView);
    res.json({
      current: history.length ? history[history.length - 1] : null,
      history,
      taxonomy: { categories: REASON_CODES, recommendations: RECOMMENDATIONS },
      note: 'Decisions are append-only. A revision supersedes its predecessor; nothing is rewritten.',
    });
  });

  // ------------------------------------------------- internal evidence state

  orgRouter.post('/rooms/:id/evidence/:eid/review', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    if (!requireCan(req, res, room, 'comment')) return;
    const state = String(req.body?.state ?? '');
    if (!EVIDENCE_REVIEW_STATES.includes(state)) return res.status(400).json({ error: 'ROOM_EVIDENCE_STATE_UNKNOWN' });
    const evidence = db.evidence.find((e) => e.id === req.params.eid && e.playerId === room.playerId);
    if (!evidence) return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    const note = req.body?.note ? plainText(req.body.note, 1000) : null;
    if (note && !moderateOrRefuse(res, note, { kind: 'recruitment_room_evidence_note', orgId: req.org.id })) return;

    let row = db.roomEvidenceState.find((x) => x.roomId === room.id && x.evidenceId === evidence.id);
    if (!row) {
      row = { id: nextId('rev'), roomId: room.id, orgId: req.org.id, evidenceId: evidence.id, state, note, byId: req.orgUser.id, byName: req.orgUser.name, at: now() };
      db.roomEvidenceState.push(row);
    } else {
      Object.assign(row, { state, note: note ?? row.note, byId: req.orgUser.id, byName: req.orgUser.name, at: now() });
    }
    // The review state and the note belong to the ROOM. The evidence record
    // itself is the player's and is not touched.
    activity(room, req, 'room_evidence_reviewed', { evidenceId: evidence.id, state });
    room.room.updatedAt = now();
    persistNow();
    res.json({ review: { evidenceId: evidence.id, state: row.state, note: row.note, by: row.byName, at: row.at }, note: 'Internal review state only — the evidence record itself is unchanged.' });
  });

  // -------------------------------------------------------------- bridges

  /** Assign an assessment as a named piece of work on this room. */
  orgRouter.post('/rooms/:id/assessment-assignments', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    if (!requireCan(req, res, room, 'assign')) return;
    const u = orgUser(req.org.id, String(req.body?.userId ?? ''));
    if (!u) return res.status(404).json({ error: 'USER_NOT_IN_ORG' });
    const kind = plainText(req.body?.kind, 60) || 'Assessment';
    const a = { id: nextId('asg'), userId: u.id, name: u.name, task: `${kind} assessment`, dueAt: req.body?.dueAt ?? null, status: 'open', createdAt: now() };
    room.assignments ??= [];
    room.assignments.push(a);
    activity(room, req, 'room_assessment_assigned', { assignmentId: a.id, userId: u.id, kind });
    vmetric('room_assessment_assigned');
    room.room.updatedAt = now();
    if (u.id !== req.orgUser.id) notify({ kind: 'org_user', id: u.id }, 'recruitment_room', `${req.orgUser.name} assigned you a ${kind.toLowerCase()} assessment for ${room.playerName}.`, room.id);
    persistNow();
    res.status(201).json({ assignment: a });
  });

  /** Raise an evidence request through the M13 engine — same rules, no shortcut. */
  orgRouter.post('/rooms/:id/evidence-requests', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    if (!requireCan(req, res, room, 'request_evidence')) return;
    if (!ctx.requestEvidenceGap) return res.status(503).json({ error: 'EVIDENCE_ENGINE_UNAVAILABLE' });
    const suggestionId = String(req.body?.suggestionId ?? '');
    // Deliberately no free-text field: a scout can never send their own words
    // to a player or a guardian from inside a private room. The engine's
    // whitelisted, rule-derived wording is the only thing that travels.
    const out = ctx.requestEvidenceGap({ org: req.org, suggestionId });
    if (!out.ok) return res.status(out.status).json({ error: out.error, ...(out.message ? { message: out.message } : {}), ...(out.detail ?? {}) });
    activity(room, req, 'room_evidence_requested', { suggestionId, ruleId: out.suggestion.ruleId, routedTo: out.routedTo });
    vmetric('room_evidence_requested');
    room.room.updatedAt = now();
    persistNow();
    res.status(201).json({ suggestion: out.suggestion, routedTo: out.routedTo, note: 'Routed through the standing evidence-request rules, including guardian routing for under-18s.' });
  });

  /** Request standardized Combine protocols through the M16.1 creator. */
  orgRouter.post('/rooms/:id/combine-requests', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    if (!requireCan(req, res, room, 'request_combine')) return;
    if (!ctx.createCombineRequests) return res.status(503).json({ error: 'COMBINE_UNAVAILABLE' });
    if (req.org.type === 'agency') return res.status(403).json({ error: 'AGENCY_NOT_ELIGIBLE' });
    if (!req.org.verified) return res.status(403).json({ error: 'ORG_NOT_ELIGIBLE', message: 'Only a verified organisation can create a Club Combine.' });
    if (limited(`room:combine:${req.org.id}`, 60, 3_600_000)) return res.status(429).json({ error: 'RATE_LIMITED' });

    const ids = Array.isArray(req.body?.protocolIds) ? [...new Set(req.body.protocolIds.map(String))] : [];
    if (!ids.length) return res.status(400).json({ error: 'PROTOCOLS_REQUIRED' });
    // Protocols are selected from the standardized registry. A room can never
    // invent one or change one's rules.
    for (const pid of ids) if (!ctx.combineProtocolActive?.(pid)) return res.status(404).json({ error: 'PROTOCOL_UNKNOWN', protocolId: pid });
    const instructions = req.body?.instructions ? String(req.body.instructions) : null;
    if (instructions && !moderateOrRefuse(res, instructions, { kind: 'combine_request', orgId: req.org.id })) return;

    const out = ctx.createCombineRequests({
      org: req.org, orgUser: req.orgUser, playerIds: [room.playerId],
      protocolIds: ids, title: req.body?.title ?? null, deadline: req.body?.deadline ?? null, instructions,
    });
    if (!out.created.length) return res.status(409).json({ error: 'NOT_VISIBLE', skipped: out.skipped });
    activity(room, req, 'room_combine_requested', { requestId: out.created[0].id, protocols: ids });
    vmetric('room_combine_requested');
    room.room.updatedAt = now();
    persistNow();
    res.status(201).json({ request: ctx.combineRequestView?.(out.created[0]) ?? out.created[0] });
  });

  /**
   * Link a canonical record to this room. Trials, contact requests and signings
   * are created by their own workflows — the Room references them, exactly as
   * M12 cases already do, so there is never a duplicate trial or signing row.
   */
  orgRouter.post('/rooms/:id/link', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    if (!requireCan(req, res, room, 'assign')) return;
    const { trialId, signingId, requestId } = req.body ?? {};
    room.links ??= { requestIds: [], trialIds: [], signingId: null };

    if (trialId) {
      const t = db.trials.find((x) => x.id === trialId && x.orgId === req.org.id && x.playerId === room.playerId);
      if (!t) return res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
      if (!room.links.trialIds.includes(t.id)) room.links.trialIds.push(t.id);
      activity(room, req, 'room_trial_linked', { trialId: t.id, status: t.status });
      vmetric('room_trial_requested');
    }
    if (requestId) {
      const r = db.requests.find((x) => x.id === requestId && x.orgId === req.org.id && x.playerId === room.playerId);
      if (!r) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
      if (!room.links.requestIds.includes(r.id)) room.links.requestIds.push(r.id);
    }
    if (signingId) {
      const s = db.signings.find((x) => x.id === signingId && x.orgId === req.org.id && x.playerId === room.playerId);
      if (!s) return res.status(404).json({ error: 'SIGNING_NOT_FOUND' });
      room.links.signingId = s.id;
      activity(room, req, 'room_signing_linked', { signingId: s.id });
    }
    room.room.updatedAt = now();
    persistNow();
    res.json({ links: room.links });
  });

  /** Organisation-private recruitment funnel. No cross-club comparison exists. */
  orgRouter.get('/rooms-funnel', (req, res) => {
    const mine = db.recruitmentCases.filter((c) => c.orgId === req.org.id && isRoom(c));
    res.json(roomFunnel(mine));
  });

  // ------------------------------------------------------------------ T&S

  /**
   * Trust & Safety does NOT browse club decision rooms. This surface reports
   * platform-level counts and nothing from inside any room: no status, no
   * comment, no decision, no reason, no player and no organisation.
   */
  adminRouter.get('/rooms/overview', (req, res) => {
    res.json({
      rooms: db.recruitmentCases.filter(isRoom).length,
      comments: db.roomComments.length,
      decisions: db.roomDecisions.length,
      snapshots: db.roomSnapshots.length,
      note: 'Recruitment Rooms are private to the organisation that owns them. Trust & Safety has no routine read access to their contents — an investigation needs an explicit, audited, reasoned support grant.',
    });
  });

  // ------------------------------------------- legacy stage route alignment
  //
  // M12's `POST /org/cases/:id/stage` still works. When the case happens to be
  // a Room, the same write lands on the room status through the SAME mapping,
  // so the two representations can never drift apart.
  ctx.syncRoomStatusFromStage = (record, org) => {
    if (!isRoom(record)) return;
    const mapped = roomStatusForStage(record.stage, org.level);
    if (mapped && mapped !== record.room.status) {
      record.room.status = mapped;
      record.room.updatedAt = now();
    }
  };
}
