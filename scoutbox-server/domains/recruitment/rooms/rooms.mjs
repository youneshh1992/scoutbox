// Recruitment Rooms: stores, the room projector and the org routes.
//
// A Room is the CLUB's private decision workspace around one player. It is a
// facet of the recruitment case, never a second pipeline: `room.status` is
// canonical and `case.stage` is derived from it by `statusMove` alone.
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
  ROOM_STATUSES, ROOM_STATUS_LABELS, OPEN_ROOM_STATUSES, ROOM_TRANSITIONS, REOPENED_FROM,
  PRO_STAGES, GRASSROOTS_STAGES, stageForRoomStatus, roomStatusForStage,
  validateTransition, validateReasonCodes, validateDecision, REASON_CODES,
  ALL_REASON_CODES, PROHIBITED_REASON_CODES, RECOMMENDATIONS,
  decisionReadiness, roomHealth, ROOM_HEALTH_LABELS, roomRole, roomCan,
  normaliseSourceContext, SOURCE_CONTEXTS, TASK_STATES, canTaskTransition,
  LINKED_RESOURCE_TYPES, EVIDENCE_REVIEW_STATES, ROOM_PRIORITIES,
  ROOM_PRIORITY_NOTE, roomActivity, buildRoomSnapshot, roomSummary, roomFunnelFromCounts,
  secondLookEvent, ROOM_TRUST_NOTE, ROOM_DEV_NOTE, ROOM_PRIVACY_NOTE,
  ROOM_UNAVAILABLE_NOTE, LIMITS, clampPage, validateTag, SNAPSHOT_STATUSES,
  adoptionStatusForStage, INITIAL_ROOM_STATUS, canTransition,
} from './shared.mjs';
import { guardRev, revMeta } from '../../platform/concurrency.mjs';
import { rateLimitedBody, limitCheck } from '../../platform/rateLimit.mjs';
// The lifecycle's own role table, so the legacy status route and the
// semantic-action route agree on WHO may reach a state (a room lead could reach
// `signed` here while `confirmSignedOutcome` needs a recruitment lead).
import { LIFECYCLE_ACTIONS } from '../lifecycle/lifecycle.mjs';

import { readPage, sendPageError } from '../../platform/paging.mjs';
import { isAbsent, parseStrictDateOnly } from '../../../temporal.mjs';
import { now } from '../../platform/clock.mjs';
import { normaliseClientKey } from '../../platform/idempotency.mjs';
export function registerRooms(ctx) {
  const {
    byId, users, orgRouter, adminRouter, nextId, notify, ledgerAppend, broadcast,
    findPlayer, moderateOrRefuse, playerViewForOrg, orgCanSee, isLead, auditEntry, vmetric,
    faults = null,
    recruitmentCases, unit, dueAtOrRefuse, // every case and room write is an explicit repository operation, inside `unit` when it touches more than one row
    recruitmentEvidence,
  } = ctx;
  const reads = ctx.recruitmentReads;
  if (typeof reads?.signings?.forPlayer !== 'function') throw new TypeError('registerRooms needs recruitmentReads (signings) from the data layer');
  if (typeof unit !== 'function' || !recruitmentCases?.cases) throw new TypeError('registerRooms needs the recruitment-cases repository and unit from the data layer');
  if (typeof recruitmentEvidence?.check !== 'function') throw new TypeError('registerRooms needs the recruitment evidence provider');
  const { cases, comments, snapshots, decisions, evidenceStates } = recruitmentCases;

  // ------------------------------------------------------------- utilities

  const orgUsers = (orgId) => users.forOrg(orgId, { active: true });
  // The staff index, not a scan of the club's staff.
  const orgUser = (orgId, userId) => { const u = byId.user(userId); return u && u.orgId === orgId && !u.removedAt ? u : null; };

  // Fixed-window counters for the abuse surfaces; nothing here is
  // security-critical state. One shared limiter, one named policy per action.
  const limited = limitCheck(ctx.rateLimit);

  // Comment bodies are stored inert: markup is removed on write, so no renderer
  // anywhere — ours or a future one — can be talked into executing it.
  const plainText = (s, max) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, max);
  const isRoom = (c) => !!c?.room;

  /**
   * The player header inside a Room.
   *
   * `playerViewForOrg` carries a LEGACY `trustScore` from the original
   * safeguarding heuristic, separate from the Trust Score. Two different
   * numbers both called "trust" in one header is exactly how an
   * evidence-confidence score gets read as a player rating, so the Room shows
   * one: the Trust Score, with its disclaimer attached. The legacy field is
   * untouched everywhere else — this is a presentation decision local to Rooms.
   */
  function roomPlayerView(player, org) {
    const view = playerViewForOrg(player, org);
    if (!view) return null;
    const { trustScore, trust, ...rest } = view;
    return rest;
  }

  /** An assessment's `context` is a word or an object; the Room list row shows a short label. */
  function assessmentContextLabel(ctx) {
    if (ctx == null) return null;
    if (typeof ctx === 'string') return ctx;
    if (typeof ctx !== 'object') return null;
    const bits = [ctx.fixture, ctx.date].filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    if (bits.length) return bits.join(' · ');
    return ctx.trialId ? 'trial' : null;
  }

  /**
   * The single writer of room status: the move `cases.moveRoom` makes. `case.stage` is derived here and only here, and
   * the move bumps the Room's rev, so the shared reopen bridge gets the concurrency token for free.
   */
  function statusMove(status, org, by = null) {
    const at = now();
    const open = OPEN_ROOM_STATUSES.includes(status);
    return {
      to: status, stage: stageForRoomStatus(status, org.level), at, by,
      archivedAt: status === 'archived' ? at : open ? null : undefined,
      closedAt: status === 'closed' ? at : open ? null : undefined,
    };
  }

  // ---------------------------------------------------------- room lookup

  /**
   * Org-scoped lookup with 404 concealment. A room belonging to another club is
   * indistinguishable from a room that does not exist — the response, the
   * status code and the body are identical.
   */
  function findRoom(req, res) {
    const found = reads.cases.byId(req.params.id);
    const c = found && found.orgId === req.org.id && isRoom(found) ? found : null;
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

  /** A history entry for an act of the club user on the request. */
  const activity = (req, type, detail = null) => auditEntry('org', req.orgUser.id, req.orgUser.name, type, detail);
  /** The bookkeeping of a Room act: its history entries, with the Room's last activity moved to now. */
  const touched = (...history) => ({ at: now(), touch: true, history });

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

    // Combine obeys the identical dual consent rule the Combine applies: the standing
    // gates AND (the player's recruitment opt-in OR this org's own request).
    const maySeeCombine = ctx.combineOrgMaySeeResults?.(org, player) ?? false;
    const combine = maySeeCombine ? (ctx.combineProjection?.(player.id) ?? null) : null;
    const combineRequests = ctx.boxCamReads.requests.forOrg(org.id, { playerId: player.id }).reverse() // oldest first
      .map((r) => ctx.combineRequestView(r));

    // Development activity only behind the player's own recruitment share pref.
    const prefs = ctx.boxPrefsFor?.(player.id) ?? {};
    const development = prefs.shareDevelopmentActivity === 'recruitment'
      ? { ...(passport?.developmentActivity ?? {}), note: ROOM_DEV_NOTE }
      : { shared: false, note: 'This player has not shared development activity for recruitment.' };

    return { visible: true, player, viewerKind, trust, trustProfile, full, passport, combine, maySeeCombine, combineRequests, development };
  }

  // ------------------------------------------------------- room components

  const roomComments = (roomId) => reads.comments.forRoom(roomId);
  /** A comment of this Room, or null. */
  const commentOf = (id, roomId) => { const c = reads.comments.byId(id); return c && c.roomId === roomId ? c : null; };
  const roomDecisions = (roomId) => reads.decisions.forRoom(roomId).slice().sort((a, b) => a.createdAt - b.createdAt);
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
      // A formal decision is the same row with an outcome; any other row is
      // an advisory recommendation.
      kind: d.kind === 'formal' ? 'formal' : 'recommendation',
      outcome: d.kind === 'formal' ? d.outcome ?? null : null,
      lifecycle: d.kind === 'formal' ? d.lifecycle ?? null : null,
    };
  }

  /** Assessments for this org only, through the existing blind-until-submit rule. */
  function assessmentsFor(req, room) {
    const mine = ctx.scoutingReads.assessments.forOrgPlayer(req.org.id, room.playerId);
    const lead = isLead(req.orgUser);
    const ownNonDraft = mine.some((a) => a.scoutUserId === req.orgUser.id && a.state !== 'draft');
    return mine
      // Calibration policy: a scout cannot read a peer's submitted
      // assessment until they have submitted their own. The Room surfaces
      // assessments; it does not become a way around that.
      .filter((a) => lead || a.scoutUserId === req.orgUser.id || (a.state !== 'draft' && ownNonDraft))
      .map((a) => ({
        id: a.id, scoutUserId: a.scoutUserId, scoutName: a.scoutName,
        templateId: a.templateId, templateVersion: a.templateVersion,
        // An assessment's recommendation is `{ verdict, reasons }`; the Room reads the
        // verdict WORD only. The reasons are the scout's rationale and belong to the
        // assessment surface, not to a list row — and the client expects a word here.
        state: a.state, recommendation: typeof a.recommendation === 'string' ? a.recommendation : (a.recommendation?.verdict ?? null),
        // Likewise the context: a word or a short label (fixture · date, or "trial"), never the object.
        context: assessmentContextLabel(a.context), createdAt: a.createdAt, submittedAt: a.submittedAt ?? null,
      }));
  }

  const blindWithheld = (req, room) => {
    const mine = ctx.scoutingReads.assessments.forOrgPlayer(req.org.id, room.playerId);
    const visible = assessmentsFor(req, room).length;
    return mine.length - visible;
  };

  /**
   * The org-visible evidence list, plus the Room's own private review state.
   *
   * The Passport's club projection deliberately returns `evidence` as a SUMMARY
   * object (`{fullMatches, clips, references, lastEvidenceDays, …}`), not a row
   * list — so the Room reads the canonical evidence rows itself (scoutingReads) and keeps
   * the summary for the header. Access is already settled: `sources()` returned
   * `visible: true`, which means `orgCanSee` passed on this read.
   */
  function evidenceFor(req, room, srcs) {
    const state = reads.evidenceStates.forRoom(room.id);
    const list = [...ctx.scoutingReads.evidence.currentForPlayer(room.playerId)]
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
    return reads.trials.forOrgPlayer(req.org.id, room.playerId)
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
      // Concurrency token: moves on every accepted workflow mutation, so
      // a second scout editing a stale copy is refused rather than silently
      // overwriting the first.
      ...revMeta(room.room),
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
    let page;
    try { page = readPage(req.query, ['number', 'string']); } catch (e) { return sendPageError(res, e); }
    const viewer = { userId: req.orgUser.id, isLead: isLead(req.orgUser) };

    // The access rule (roomRole), the view and the filters are applied in SQL; only the page is decoded.
    const VIEW_STATUSES = {
      shortlisted: ['shortlisted', 'priority'], trials: ['trial_requested', 'trial_scheduled', 'trial_completed'],
      offers: ['offer_consideration', 'offer_made'], archived: ['archived', 'closed', 'withdrawn'], active: OPEN_ROOM_STATUSES,
    };
    const view = String(req.query.view ?? 'all');
    const filter = {
      statuses: VIEW_STATUSES[view] ?? null,
      mineOf: view === 'mine' ? req.orgUser.id : null,
      assignedTo: view === 'assigned' ? req.orgUser.id : null,
      status: req.query.status ? String(req.query.status) : null,
      tag: req.query.tag ? String(req.query.tag) : null,
      assignee: req.query.assignee ? String(req.query.assignee) : null,
    };

    // The search needs the player's visibility, so it is the one filter applied in code, as the rows are read.
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const matches = q ? (c) => {
      const p = findPlayer(c.playerId);
      const visible = p && orgCanSee(req.org, p);
      return (visible && (c.playerName ?? '').toLowerCase().includes(q))
        || c.tags.some((t) => t.toLowerCase().includes(q))
        || ROOM_STATUS_LABELS[c.status].toLowerCase().includes(q);
    } : null;

    // Most recent activity first, paged by cursor ({ items, nextCursor }; domains/platform/paging.mjs).
    const { items: pageRows, nextCursor } = reads.cases.roomPageForViewer(req.org.id, viewer, filter, page, matches);

    // One light assembly per player on the page, shared between the Passport
    // and Trust engines — no per-row source round trip.
    const items = pageRows.map((c) => {
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
      items, nextCursor,
      funnel: roomFunnelFromCounts(reads.cases.roomStatusCounts(req.org.id, viewer)),
      statuses: ROOM_STATUSES.map((s) => ({ id: s, label: ROOM_STATUS_LABELS[s] })),
      note: 'Rooms are listed by most recent activity. ScoutBox never orders players by Trust Score.',
    });
  });

  /** Needs-attention: deterministic, no priority scoring of any kind. Read as sets, not per Room. */
  orgRouter.get('/rooms/needs-attention', (req, res) => {
    const orgId = req.org.id;
    const open = reads.cases.roomRowsForViewer(orgId, { userId: req.orgUser.id, isLead: isLead(req.orgUser) }, { statuses: OPEN_ROOM_STATUSES });
    const overdue = reads.cases.overdueTaskCounts(orgId, now());
    const supplied = ctx.insightReads.suggestions.playerIdsWithStatus(orgId, 'supplied'); // one indexed query
    const doneCombine = ctx.boxCamReads.requests.completedPlayerIds(orgId); // one indexed query
    const reported = reads.trials.playerIdsForOrgStatus(orgId, 'reported');
    const decided = reads.decisions.roomIdsForOrg(orgId);
    const items = [];
    for (const c of open) {
      const reasons = [];
      const n = overdue.get(c.id) ?? 0;
      if (n) reasons.push({ code: 'TASK_OVERDUE', text: `${n} task(s) past their due date.` });
      if (supplied.has(c.playerId)) reasons.push({ code: 'EVIDENCE_RETURNED', text: 'Requested evidence has arrived.' });
      if (doneCombine.has(c.playerId)) reasons.push({ code: 'COMBINE_COMPLETED', text: 'A requested Combine has been completed.' });
      if (reported.has(c.playerId) && c.status === 'trial_scheduled') reasons.push({ code: 'TRIAL_REPORTED', text: 'A trial report is in.' });
      if (['offer_consideration', 'offer_made'].includes(c.status) && !decided.has(c.id)) reasons.push({ code: 'DECISION_OUTSTANDING', text: 'No decision has been recorded yet.' });
      if (reasons.length) items.push({ roomId: c.id, playerId: c.playerId, playerName: c.playerName, status: c.status, reasons });
    }
    res.json({ items, note: 'Deterministic workflow signals only. ScoutBox does not rank or score these for you.' });
  });

  /** Which of these players already have a room? Used by the search screen. */
  orgRouter.get('/rooms/summaries', (req, res) => {
    const ids = String(req.query.playerIds ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    const items = ids.map((pid) => {
      const c = reads.cases.forOrgPlayer(req.org.id, pid).find((x) => isRoom(x) && OPEN_ROOM_STATUSES.includes(x.room.status));
      if (!c || (c.restricted && !roomRole({ room: c, user: req.orgUser, isLead: isLead(req.orgUser) }))) return { playerId: pid, roomId: null, status: null };
      return { playerId: pid, roomId: c.id, status: c.room.status, statusLabel: ROOM_STATUS_LABELS[c.room.status] };
    });
    res.json({ items });
  });

  // ----------------------------------------------------------- create room

  /**
   * Open a Room for a player (inside the caller's unit): adopt this org's open case for the player if one exists — a
   * Room is a facet of the case, so a club never ends up with a case and a room that disagree about where the player
   * is in the pipeline — or create the case with the facet in one write. Returns the fresh case.
   */
  function openRoom({ req, player, sourceContext, sourceRef, priority = 'normal', restricted = false, vacancyId = null, withSourceRef = true }) {
    const existingCase = reads.cases.forOrgPlayer(req.org.id, player.id).find((c) => c.stage !== 'closed' && !isRoom(c));
    const adopted = !!existingCase;
    const at = now();
    // The case already had a stage — keep its meaning rather than resetting the club's pipeline position to the
    // start, without asserting a fact the records cannot prove (see `adoptionStatus`).
    const inheritedStage = adopted ? (existingCase.stage ?? null) : null;
    const status = inheritedStage ? adoptionStatusForStage(inheritedStage, req.org.level) : INITIAL_ROOM_STATUS;
    const move = statusMove(status, req.org, req.orgUser);
    const by = { userId: req.orgUser.id, name: req.orgUser.name };
    // Opening the Room is its first revision.
    const room = {
      status, priority, tags: [], leadScoutUserId: req.orgUser.id,
      sourceContext, sourceRef: withSourceRef ? sourceRef : null, openedBy: by,
      updatedAt: move.at, archivedAt: move.archivedAt ?? null, closedAt: move.closedAt ?? null,
      rev: 1, revAt: move.at, revBy: by,
    };
    const history = [activity(req, 'room_created', { status, sourceContext, ...(withSourceRef ? { sourceRef } : {}), adoptedExistingCase: adopted, inheritedStage })];
    if (adopted) return { room: cases.openRoom(existingCase.id, { room, stage: move.stage }, { history }), adopted };
    return {
      room: cases.create({
        id: nextId('case'), orgId: req.org.id, playerId: player.id, playerName: player.name,
        vacancyId, ownerUserId: req.orgUser.id, ownerName: req.orgUser.name,
        stage: move.stage, priority: 'medium', deadline: null, restricted,
        assignments: [], tasks: [], approvals: [], decision: null,
        links: { requestIds: [], trialIds: [], signingId: null },
        createdAt: at, history, room,
      }),
      adopted,
    };
  }

  orgRouter.post('/rooms', (req, res) => {
    if (limited('room_create', req.org.id)) return res.status(429).json(rateLimitedBody('room_create'));
    const { playerId, sourceContext, priority, restricted, vacancyId } = req.body ?? {};
    const p = findPlayer(playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    // A room cannot be used to bookmark a player the club may not see.
    if (!orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE', message: 'This player is not visible to your organisation under the standing rules.' });
    if (vacancyId && !ctx.scoutingReads.vacancies.ofOrg(vacancyId, req.org.id)) return res.status(404).json({ error: 'VACANCY_NOT_FOUND' });

    const existing = reads.cases.forOrgPlayer(req.org.id, p.id).find((c) => isRoom(c) && OPEN_ROOM_STATUSES.includes(c.room.status));
    if (existing) {
      return res.status(409).json({
        error: 'ROOM_EXISTS', existingRoomId: existing.id, status: existing.room.status,
        message: 'Your organisation already has an active Recruitment Room for this player.',
      });
    }

    const { room, adopted } = unit(() => openRoom({ req, player: p, sourceContext: normaliseSourceContext(sourceContext), sourceRef: null, priority: ROOM_PRIORITIES.includes(priority) ? priority : 'normal', restricted: !!restricted, vacancyId: vacancyId ?? null, withSourceRef: false }));
    vmetric('recruitment_room_created');
    ledgerAppend?.({ type: 'recruitment_room_created', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
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

    // Guard the fields where a lost update changes who is responsible
    // for a decision or how urgent it is. Tags and a deadline are not worth a
    // conflict — demanding a rev for every trivial edit teaches people to send
    // whatever number makes the error go away.
    const workflowFields = priority !== undefined || leadScoutUserId !== undefined
      || ownerUserId !== undefined || restricted !== undefined;
    if (workflowFields && !guardRev(req, res, room.room, {
      errorCode: 'ROOM_VERSION_CONFLICT',
      current: { status: room.room.status, priority: room.room.priority, updatedAt: room.room.updatedAt },
    })) return;

    // Every field is judged before anything is written: a refusal leaves the room exactly as it was.
    if (priority !== undefined) {
      if (!ROOM_PRIORITIES.includes(priority)) return res.status(400).json({ error: 'ROOM_PRIORITY_UNKNOWN' });
      if (!requireCan(req, res, room, 'set_status')) return;
    }
    let cleanTags;
    if (tags !== undefined) {
      if (!Array.isArray(tags)) return res.status(400).json({ error: 'ROOM_TAGS_INVALID' });
      if (tags.length > LIMITS.tagsPerRoom) return res.status(400).json({ error: 'ROOM_TAGS_TOO_MANY' });
      const out = [];
      for (const raw of tags) {
        const v = validateTag(raw);
        if (!v.ok) return res.status(400).json(v);
        out.push(v.tag);
      }
      cleanTags = [...new Set(out)];
    }
    if (leadScoutUserId !== undefined) {
      if (!requireCan(req, res, room, 'assign')) return;
      if (leadScoutUserId !== null && !orgUser(req.org.id, leadScoutUserId)) return res.status(404).json({ error: 'USER_NOT_IN_ORG' });
    }
    let owner = null;
    if (ownerUserId !== undefined) {
      // A departed owner must never leave a room unusable: any recruitment
      // lead can reassign it, not only the owner.
      if (!requireCan(req, res, room, 'reassign_owner')) return;
      owner = orgUser(req.org.id, ownerUserId);
      if (!owner) return res.status(404).json({ error: 'USER_NOT_IN_ORG' });
    }
    if (restricted !== undefined && !requireCan(req, res, room, 'set_status')) return;
    const due = deadline === undefined ? undefined : dueAtOrRefuse(res, deadline, 'deadline');
    if (due === undefined && deadline !== undefined) return;

    const history = [
      ...(priority !== undefined ? [activity(req, 'room_priority_changed', { priority })] : []),
      ...(cleanTags !== undefined ? [activity(req, 'room_tag_changed', { count: cleanTags.length })] : []),
      ...(leadScoutUserId !== undefined ? [activity(req, 'room_member_assigned', { leadScoutUserId })] : []),
      ...(owner ? [activity(req, 'room_owner_changed', { ownerUserId: owner.id })] : []),
    ];
    const fresh = cases.editRoom(room.id, {
      priority, tags: cleanTags, leadScoutUserId, owner: owner ?? undefined,
      restricted: restricted === undefined ? undefined : !!restricted, deadline: deadline === undefined ? undefined : due,
    }, { ...touched(...history), bump: workflowFields, revBy: req.orgUser });
    res.json({ room: buildRecruitmentRoom(fresh, req) });
  });

  // ----------------------------------------------------------- status move

  orgRouter.post('/rooms/:id/status', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    if (!requireCan(req, res, room, 'set_status')) return;
    // A stale transition is the dangerous one: shortlisting and archiving race,
    // and the loser would otherwise overwrite the winner's decision context.
    if (!guardRev(req, res, room.room, {
      errorCode: 'ROOM_VERSION_CONFLICT',
      current: { status: room.room.status, statusLabel: ROOM_STATUS_LABELS[room.room.status], updatedAt: room.room.updatedAt },
    })) return;

    const to = String(req.body?.status ?? '');
    // Role parity. Every state a semantic action reaches carries that
    // action's role requirement HERE too; otherwise this route is the side
    // door around it (a room lead reaching `signed`, which the lifecycle
    // reserves for a recruitment lead). A state no action names keeps the
    // Room's `set_status` rule.
    const namingActions = Object.values(LIFECYCLE_ACTIONS).filter((a) => a.to === to);
    if (namingActions.length) {
      const role = roleFor(req, room);
      const rank = { viewer: 0, contributor: 1, room_lead: 2, recruitment_admin: 3 };
      const allowed = namingActions.some((a) => a.roles.some((r) => (rank[role] ?? -1) >= rank[r]));
      if (!allowed) return res.status(403).json({ error: 'ROOM_PERMISSION_REQUIRED', message: 'Your role cannot move the room to that state.', required: [...new Set(namingActions.flatMap((a) => a.roles))] });
    }
    const reasons = validateReasonCodes(req.body?.reasonCodes ?? []);
    if (!reasons.ok) return res.status(400).json(reasons);
    const note = req.body?.note == null ? null : plainText(req.body.note, 2000);
    if (note && !moderateOrRefuse(res, note, { kind: 'recruitment_room', orgId: req.org.id })) return;

    const check = validateTransition(room.room.status, to, { reasonCodes: reasons.codes });
    if (!check.ok) return res.status(check.error === 'ROOM_TRANSITION_INVALID' ? 409 : 400).json(check);

    // A status that asserts a durable fact needs the record proving it.
    //
    // This route takes a status string from the client, so without this gate it
    // is a side door around the lifecycle: `offer_made` + `{status:'signed'}`
    // would land on `signed` with no signing in the database. The
    // requirement is keyed by TARGET status in domains/recruitment/rooms/shared.mjs, so every path to
    // `signed` carries the identical burden and no future edge can skip it.
    if (check.requiresEvidence) {
      const verdict = recruitmentEvidence.check(check.requiresEvidence, { kase: room });
      if (verdict.satisfied !== true) {
        return res.status(422).json({
          error: 'ROOM_EVIDENCE_REQUIRED',
          message: `"${to}" records something that must actually have happened; no supporting record was found.`,
          requires: check.requiresEvidence,
          evidenceReason: verdict.reason ?? 'unsatisfied',
        });
      }
    }

    const from = room.room.status;
    const ends = ['archived', 'closed', 'withdrawn'].includes(to);
    let snapshot = null;
    const fresh = unit(() => {
      // Snapshot the evidence confidence the club could see AT this moment.
      if (check.snapshot) snapshot = captureSnapshot(room, req, `status:${to}`);
      const reopened = check.reopen ? { by: { userId: req.orgUser.id, name: req.orgUser.name }, at: now(), from, reasonCodes: reasons.codes } : undefined;
      cases.moveRoom(room.id, { ...statusMove(to, req.org, req.orgUser), reopened }, {
        history: [
          ...(check.reopen ? [activity(req, 'room_reopened', { from, to, reasonCodes: reasons.codes })] : []),
          activity(req, 'room_status_changed', { from, to, reasonCodes: reasons.codes, note: note ? true : false }),
        ],
      });
      // Keep the case's sign-off artefact consistent so "closing needs a decision"
      // stays true without a second decision store fighting this one.
      const signOff = to === 'signed' ? { outcome: 'sign', reasons: reasons.codes.join(', ') || 'signed' } : ends ? { outcome: 'pass', reasons: reasons.codes.join(', ') } : null;
      if (signOff) cases.recordDecision(room.id, { decision: { ...signOff, byUserId: req.orgUser.id, byName: req.orgUser.name, approvedBy: null, at: now() } });
      // A status that ends pursuit records a decision so the reason survives as
      // machine-readable decision memory, not as a status flag alone.
      if (ends) recordDecision(room, req, { recommendation: 'archive', reasonCodes: reasons.codes, note, snapshot, trigger: `status:${to}` });
      return cases.byId(room.id);
    });
    if (check.reopen) vmetric('recruitment_room_reopened');
    vmetric('recruitment_room_status_changed');
    broadcast?.('recruitment_case_moved', { orgId: room.orgId, roomId: room.id, from, to });
    if (ends) vmetric('recruitment_room_archived');
    if (to === 'signed') vmetric('recruitment_room_signed');

    for (const u of orgUsers(req.org.id)) {
      if (u.id === req.orgUser.id) continue;
      if (u.id === fresh.ownerUserId || u.id === fresh.room.leadScoutUserId) {
        notify({ kind: 'org_user', id: u.id }, 'recruitment_room', `Recruitment Room — ${fresh.playerName ?? 'a removed player'}: ${ROOM_STATUS_LABELS[to]}.`, fresh.id);
      }
    }
    res.json({ room: buildRecruitmentRoom(fresh, req), snapshot });
  });

  /**
   * The ONE reopen path, shared with Second Look.
   *
   * A Second Look never reopens a room by itself — a recruiter does, and when
   * they do, the move runs through exactly this code: the same transition
   * table, the same reason requirement, the same snapshot capture, the same
   * append-only decision memory and the same activity trail. Second Look supplies only
   * the source context so the reopen is attributable later.
   */
  ctx.reopenRoom = ({ req, room, to = 'under_review', reasonCodes = [], sourceContext = null, sourceRef = null }) => {
    const role = roleFor(req, room);
    if (!roomCan(role, 'reopen')) return { ok: false, status: 403, error: 'ROOM_PERMISSION_REQUIRED' };
    // A reopen reopens something CLOSED. A live room (contacted,
    // shortlisted, on hold…) pulled back to under_review through this bridge
    // would rewrite a live case under a "reopened" label; it is refused.
    if (!REOPENED_FROM.includes(room.room.status)) {
      return { ok: false, status: 409, error: 'ROOM_NOT_REOPENABLE', message: `A room at ${ROOM_STATUS_LABELS[room.room.status] ?? room.room.status} is not closed, so it cannot be reopened.`, current: { status: room.room.status } };
    }
    const reasons = validateReasonCodes(reasonCodes);
    if (!reasons.ok) return { ok: false, status: 400, ...reasons };
    const check = validateTransition(room.room.status, to, { reasonCodes: reasons.codes });
    if (!check.ok) return { ok: false, status: check.error === 'ROOM_TRANSITION_INVALID' ? 409 : 400, ...check };

    // Same gate as the status route. `to` is a parameter here, and the
    // Second Look bridge supplies it, so an evidence-bearing target must be
    // refused on this path too rather than trusted because the caller is
    // internal.
    if (check.requiresEvidence) {
      const verdict = recruitmentEvidence.check(check.requiresEvidence, { kase: room });
      if (verdict.satisfied !== true) {
        return { ok: false, status: 422, error: 'ROOM_EVIDENCE_REQUIRED', requires: check.requiresEvidence, evidenceReason: verdict.reason ?? 'unsatisfied' };
      }
    }

    const from = room.room.status;
    const fresh = unit(() => {
      if (check.snapshot) captureSnapshot(room, req, `status:${to}`);
      return cases.moveRoom(room.id, {
        ...statusMove(to, req.org, req.orgUser),
        reopened: { by: { userId: req.orgUser.id, name: req.orgUser.name }, at: now(), from, reasonCodes: reasons.codes, sourceContext, sourceRef },
        sourceContext: sourceContext || undefined,
      }, { history: [activity(req, 'room_reopened', { from, to, reasonCodes: reasons.codes, sourceContext, sourceRef })] });
    });
    vmetric('recruitment_room_reopened');
    broadcast?.('recruitment_case_moved', { orgId: room.orgId, roomId: room.id, from, to });
    return { ok: true, room: buildRecruitmentRoom(fresh, req), from, to };
  };
  ctx.findRoomForRequest = findRoom;
  ctx.roomIsRoom = isRoom;
  // The decision-time snapshot, captured by the formal decision
  // route through exactly the code the advisory recommendation uses.
  ctx.captureRoomSnapshot = (room, req, trigger) => captureSnapshot(room, req, trigger);

  /**
   * The lifecycle write seam, shared with the lifecycle module.
   *
   * The lifecycle owns which semantic actions exist and what each one requires; it does
   * NOT own how a status is written. That stays here, in `statusMove` and
   * `cases.moveRoom` — the single writer, which derives `case.stage` and bumps the rev — so there
   * is exactly one place where the two representations can be made to agree.
   *
   * The caller has already validated the transition. This performs it and
   * appends the history entry the funnel reads, in that order, so a status
   * that moved is always a status with a recorded reason for moving.
   */
  ctx.applyLifecycleTransition = ({ req, room, to, reasonCodes = [], trigger = 'lifecycle', actor = null, statusDetail = null }) => {
    const from = room.room.status;
    // A case may move BECAUSE a recipient acted (a guardian accepted
    // a concrete trial slot), through this same writer. The recipient never
    // addresses the case; the caller passes who acted, and the history entry
    // names them by kind rather than pretending a club user did it. Absent an
    // actor, the club user on the request is the actor.
    const org = actor?.org ?? req.org;
    const by = actor ? { id: actor.id ?? null, name: actor.name ?? null } : req.orgUser;
    const reopens = REOPENED_FROM.includes(from) && OPEN_ROOM_STATUSES.includes(to);
    const write = (type, detail) => (actor
      ? auditEntry(actor.kind ?? 'system', actor.id ?? null, actor.name ?? null, type, detail)
      : activity(req, type, detail));
    // One unit (joining the caller's): the status, the stage, the rev and the history entries together, or nothing.
    const fresh = unit(() => {
      // The lifecycle's resume is its own edge out of on_hold, beside the transition table.
      const resume = from === 'on_hold' && !canTransition(from, to);
      cases.moveRoom(room.id, { ...statusMove(to, org, by), resume, ...(reopens ? { reopened: { by: { userId: by.id ?? null, name: by.name ?? null }, at: now(), from, reasonCodes } } : {}) });
      // A development-only fault seam between the status write
      // and the history entry: the unit is refused whole, so status, stage,
      // rev, instants and history stay exactly as they were.
      if (faults?.shouldFail?.('lifecycle.after_status')) throw new Error('simulated failure after the status write (development fault layer)');
      // The same action name the funnel reads. A second name would
      // mean a second funnel, silently disagreeing with the first. The caller's
      // `statusDetail` (the semantic action, the policy version, the record that
      // moved the case) is part of the same entry.
      return cases.recordAct(room.id, {
        history: [
          ...(reopens ? [write('room_reopened', { from, to, reasonCodes })] : []),
          write('room_status_changed', { from, to, reasonCodes, trigger, ...(statusDetail ?? {}) }),
        ],
      });
    });
    if (reopens) vmetric('recruitment_room_reopened');
    vmetric('recruitment_room_status_changed');
    // Open Rooms re-read the journey on this event (ids and words only).
    broadcast?.('recruitment_case_moved', { orgId: room.orgId, roomId: room.id, from, to });
    return { from, to, room: fresh };
  };

  /**
   * The ONE room creator reachable from another module, shared with Nobody
   * Missed. A candidate added from a brief gets a room through exactly
   * the same path as one added from Discover: the same visibility check, the
   * same uniqueness rule, the same adoption of an existing case. Nobody Missed supplies
   * only the source context, so the funnel can later distinguish a room opened
   * from a brief from one opened organically.
   */
  ctx.createRoomForPlayer = ({ req, player, sourceContext = 'direct', sourceRef = null }) => {
    if (!orgCanSee(req.org, player)) return { ok: false, status: 403, error: 'NOT_VISIBLE' };
    const existing = reads.cases.forOrgPlayer(req.org.id, player.id).find((c) => isRoom(c) && OPEN_ROOM_STATUSES.includes(c.room.status));
    if (existing) return { ok: true, roomId: existing.id, existed: true, room: buildRecruitmentRoom(existing, req) };

    const { room } = unit(() => openRoom({ req, player, sourceContext: normaliseSourceContext(sourceContext), sourceRef }));
    vmetric('recruitment_room_created');
    ledgerAppend?.({ type: 'recruitment_room_created', playerId: player.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name });
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
          // passportVersion is the projection schema version (always 1).
          // passportRevision is the CONTENT revision, so a later
          // Second Look can say whether the Passport truth itself moved.
          passportVersion: full?.passportVersion ?? null,
          passportRevision: ctx.passportRevisionOf?.(room.playerId) ?? null,
          evidenceIds: ctx.scoutingReads.evidence.currentForPlayer(room.playerId).map((e) => e.id),
          assessmentIds: ctx.scoutingReads.assessments.forOrgPlayer(room.orgId, room.playerId).filter((a) => a.state !== 'draft').map((a) => a.id),
          // Protocol coverage at decision time — which standardized tests had a
          // verified result, never the measured values themselves.
          combineResults: (ctx.combineProjection?.(room.playerId)?.results ?? [])
            .map((r) => `${r.protocolId}@${r.protocolVersion}`),
          trialIds: (room.links?.trialIds ?? []),
        },
      }),
    };
    return snapshots.create(snap);
  }

  orgRouter.get('/rooms/:id/snapshots', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    res.json({ items: reads.snapshots.forRoom(room.id).slice().sort((a, b) => b.at - a.at) });
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
    if (limited('room_comment', `${room.id}:${req.orgUser.id}`)) {
      return res.status(429).json(rateLimitedBody('room_comment'));
    }
    const body = plainText(req.body?.body, LIMITS.commentBody);
    if (!body) return res.status(400).json({ error: 'ROOM_COMMENT_EMPTY' });
    if (!moderateOrRefuse(res, body, { kind: 'recruitment_room_comment', orgId: req.org.id })) return;

    const replyToId = req.body?.replyToId ? String(req.body.replyToId) : null;
    if (replyToId) {
      // A comment id from another room is a 404 here, not a cross-room reply.
      const parent = commentOf(replyToId, room.id);
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
    const saved = unit(() => {
      const row = comments.create(c);
      cases.recordAct(room.id, touched(activity(req, 'room_comment_added', { commentId: c.id, replyToId })));
      return row;
    });
    vmetric('room_comment_added');
    // Internal only: a mention notifies a colleague in this organisation and
    // nobody else. No player, guardian, coach, other club or email.
    for (const uid of mentions) {
      if (uid === req.orgUser.id) continue;
      notify({ kind: 'org_user', id: uid }, 'recruitment_room', `${req.orgUser.name} mentioned you in the Recruitment Room for ${room.playerName ?? 'a removed player'}.`, room.id);
    }
    res.status(201).json({ comment: commentView(saved, { orgId: req.org.id }) });
  });

  orgRouter.patch('/rooms/:id/comments/:cid', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    const c = commentOf(req.params.cid, room.id);
    if (!c) return res.status(404).json({ error: 'ROOM_COMMENT_NOT_FOUND' });
    if (c.authorId !== req.orgUser.id) return res.status(403).json({ error: 'ROOM_COMMENT_NOT_AUTHOR', message: 'Only the author can edit a comment.' });
    if (c.deletedAt) return res.status(409).json({ error: 'ROOM_COMMENT_DELETED' });
    const body = plainText(req.body?.body, LIMITS.commentBody);
    if (!body) return res.status(400).json({ error: 'ROOM_COMMENT_EMPTY' });
    if (!moderateOrRefuse(res, body, { kind: 'recruitment_room_comment', orgId: req.org.id })) return;
    const saved = unit(() => {
      const row = comments.edit(c.id, { body, at: now() });
      cases.recordAct(room.id, { history: [activity(req, 'room_comment_edited', { commentId: c.id })] });
      return row;
    });
    res.json({ comment: commentView(saved, { orgId: req.org.id }) });
  });

  orgRouter.delete('/rooms/:id/comments/:cid', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    const c = commentOf(req.params.cid, room.id);
    if (!c) return res.status(404).json({ error: 'ROOM_COMMENT_NOT_FOUND' });
    const lead = isLead(req.orgUser);
    if (c.authorId !== req.orgUser.id && !lead) return res.status(403).json({ error: 'ROOM_COMMENT_NOT_AUTHOR' });
    // Tombstone, never erase: the thread keeps its shape and the audit trail
    // keeps its attribution.
    const saved = unit(() => {
      const row = comments.remove(c.id, { at: now(), by: { userId: req.orgUser.id, name: req.orgUser.name } });
      cases.recordAct(room.id, { history: [activity(req, 'room_comment_deleted', { commentId: c.id })] });
      return row;
    });
    res.json({ comment: commentView(saved, { orgId: req.org.id }) });
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

    const dueAt = dueAtOrRefuse(res, req.body?.dueAt);
    if (dueAt === undefined) return;
    const t = {
      id: nextId('tsk'), title, description,
      assigneeUserId: assignee?.id ?? null, assigneeName: assignee?.name ?? null,
      status: 'open', dueAt,
      linkedResourceType, linkedResourceId: linkedResourceType ? String(req.body?.linkedResourceId ?? '') || null : null,
      createdBy: { userId: req.orgUser.id, name: req.orgUser.name },
      createdAt: now(), completedAt: null,
    };
    cases.addTask(room.id, { task: t }, touched(activity(req, 'room_task_created', { taskId: t.id, assigneeUserId: t.assigneeUserId })));
    vmetric('room_task_created');
    // A room task is STAFF work. It is never sent to the player: a player-facing
    // ask must go through the evidence-request or Combine-request workflow.
    if (assignee && assignee.id !== req.orgUser.id) {
      notify({ kind: 'org_user', id: assignee.id }, 'recruitment_room', `${req.orgUser.name} assigned you a task in the Recruitment Room for ${room.playerName ?? 'a removed player'}: ${title}`, room.id);
    }
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

    // Both fields are judged before anything is written.
    let status;
    if (req.body?.status !== undefined) {
      status = String(req.body.status);
      if (!TASK_STATES.includes(status)) return res.status(400).json({ error: 'ROOM_TASK_STATE_UNKNOWN' });
      const from = t.status ?? 'open';
      if (from !== status && !canTaskTransition(from, status)) return res.status(409).json({ error: 'ROOM_TASK_TRANSITION_INVALID', from, to: status });
    }
    let assignee;
    if (req.body?.assigneeUserId !== undefined) {
      if (!roomCan(role, 'assign')) return res.status(403).json({ error: 'ROOM_PERMISSION_REQUIRED' });
      if (req.body.assigneeUserId === null) assignee = null;
      else {
        assignee = orgUser(req.org.id, String(req.body.assigneeUserId));
        if (!assignee) return res.status(404).json({ error: 'USER_NOT_IN_ORG' });
      }
    }
    const fresh = cases.updateTask(room.id, {
      taskId: t.id, ...(status !== undefined ? { status, completedAt: status === 'done' ? now() : null } : {}), assignee,
    }, touched(activity(req, 'room_task_updated', { taskId: t.id, status: status ?? t.status })));
    res.json({ task: taskView(fresh.tasks.find((x) => x.id === t.id)) });
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
    const saved = decisions.create(d);
    if (prev) decisions.markSuperseded(prev.id, { by: d.id });
    const fresh = cases.recordAct(room.id, { history: [activity(req, 'room_decision_recorded', { decisionId: d.id, recommendation, reasonCodes })] });
    vmetric('room_decision_recorded');
    if (['archived', 'closed', 'withdrawn'].includes(fresh.room.status)) {
      // The Second Look contract: a typed, machine-readable domain event with
      // reason CODES and no private free text.
      // The STREAM carries ids only. secondLookEvent() remains the
      // internal shape (reason codes, revisitability, source refs) for the
      // Second Look engine and its tests; none of that belongs on a live
      // channel whose only consumer refetches through an authorised read.
      broadcast?.('recruitment_room_archived', { orgId: room.orgId, roomId: room.id });
    }
    return saved;
  }

  orgRouter.post('/rooms/:id/decisions', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    if (!requireCan(req, res, room, 'record_decision')) return;

    const key = normaliseClientKey(req.body?.clientKey, 'ROOM_CLIENT_KEY_INVALID');
    if (!key.ok) return res.status(400).json({ error: key.error, message: key.message });
    const clientKey = key.key;
    if (clientKey) {
      const dup = reads.decisions.forRoom(room.id).find((d) => d.clientKey === clientKey);
      // Idempotent submit: the same key returns the same decision instead of
      // stacking a duplicate onto the decision memory. The
      // same key with DIFFERENT content is a different request wearing the
      // same name, and a key that named a formal decision is not this
      // route's to replay — both are conflicts, never a silent old answer.
      if (dup) {
        const codesOf = (xs) => [...new Set((Array.isArray(xs) ? xs : []).map((x) => String(x)))].sort().join(',');
        const same = dup.kind !== 'formal' && (dup.recommendation ?? null) === (req.body?.recommendation ?? null)
          && codesOf(dup.reasonCodes) === codesOf(req.body?.reasonCodes);
        if (!same) return res.status(409).json({ error: 'DECISION_IDEMPOTENCY_CONFLICT', message: 'This clientKey was already used for a different decision.' });
        return res.status(200).json({ decision: decisionView(dup), idempotent: true });
      }
    }
    // A decision is pinned to the room revision it was written against.
    // Two colleagues deciding at once therefore produce ONE accepted decision
    // and one conflict — never two rows both claiming to be current. The
    // history stays append-only either way: nothing here edits a past decision.
    if (!guardRev(req, res, room.room, {
      errorCode: 'ROOM_VERSION_CONFLICT',
      current: { status: room.room.status, updatedAt: room.room.updatedAt },
    })) return;
    const check = validateDecision({
      recommendation: req.body?.recommendation,
      reasonCodes: req.body?.reasonCodes ?? [],
      note: req.body?.note ?? null,
    });
    if (!check.ok) return res.status(400).json(check);
    const note = check.note == null ? null : plainText(check.note, 2000);
    if (note && !moderateOrRefuse(res, note, { kind: 'recruitment_room_decision', orgId: req.org.id })) return;

    const { snapshot, d, fresh } = unit(() => {
      const snap = captureSnapshot(room, req, 'decision');
      const row = recordDecision(room, req, { recommendation: check.recommendation, reasonCodes: check.codes, note, snapshot: snap, trigger: 'decision', clientKey });
      const after = cases.recordAct(room.id, { at: now(), touch: true, bump: true, revBy: req.orgUser });
      return { snapshot: snap, d: row, fresh: after };
    });
    res.status(201).json({ decision: decisionView(d), snapshot, rev: fresh.room.rev });
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
    const found = ctx.scoutingReads.evidence.byId(req.params.eid);
    const evidence = found && found.playerId === room.playerId ? found : null;
    if (!evidence) return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    const note = req.body?.note ? plainText(req.body.note, 1000) : null;
    if (note && !moderateOrRefuse(res, note, { kind: 'recruitment_room_evidence_note', orgId: req.org.id })) return;

    const existing = reads.evidenceStates.forRoom(room.id).find((x) => x.evidenceId === evidence.id);
    // The review state and the note belong to the ROOM. The evidence record
    // itself is the player's and is not touched.
    const row = unit(() => {
      const saved = existing
        ? evidenceStates.review(existing.id, { state, note: note ?? existing.note, byId: req.orgUser.id, byName: req.orgUser.name, at: now() })
        : evidenceStates.create({ id: nextId('rev'), roomId: room.id, orgId: req.org.id, evidenceId: evidence.id, state, note, byId: req.orgUser.id, byName: req.orgUser.name, at: now() });
      cases.recordAct(room.id, touched(activity(req, 'room_evidence_reviewed', { evidenceId: evidence.id, state })));
      return saved;
    });
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
    const dueAt = dueAtOrRefuse(res, req.body?.dueAt);
    if (dueAt === undefined) return;
    const a = { id: nextId('asg'), userId: u.id, name: u.name, task: `${kind} assessment`, dueAt, status: 'open', createdAt: now() };
    cases.addAssignment(room.id, { assignment: a }, touched(activity(req, 'room_assessment_assigned', { assignmentId: a.id, userId: u.id, kind })));
    vmetric('room_assessment_assigned');
    if (u.id !== req.orgUser.id) notify({ kind: 'org_user', id: u.id }, 'recruitment_room', `${req.orgUser.name} assigned you a ${kind.toLowerCase()} assessment for ${room.playerName ?? 'a removed player'}.`, room.id);
    res.status(201).json({ assignment: a });
  });

  /** Raise an evidence request through the evidence-request engine — same rules, no shortcut. */
  orgRouter.post('/rooms/:id/evidence-requests', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    if (!requireCan(req, res, room, 'request_evidence')) return;
    if (!ctx.requestEvidenceGap) return res.status(503).json({ error: 'EVIDENCE_ENGINE_UNAVAILABLE' });
    const suggestionId = String(req.body?.suggestionId ?? '');
    // Deliberately no free-text field: a scout can never send their own words
    // to a player or a guardian from inside a private room. The engine's
    // whitelisted, rule-derived wording is the only thing that travels.
    // The suggestion must be about THIS room's player. A
    // room's request authority never reaches another player's profile — not
    // even one this org may otherwise see — so the id is scoped to the room.
    // One unit: the request, its notice and the Room's activity entry commit together, or none of them.
    const out = unit(() => {
      const r = ctx.requestEvidenceGap({ org: req.org, suggestionId, playerId: room.playerId });
      if (r.ok) cases.recordAct(room.id, touched(activity(req, 'room_evidence_requested', { suggestionId, ruleId: r.suggestion.ruleId, routedTo: r.routedTo })));
      return r;
    });
    if (!out.ok) return res.status(out.status).json({ error: out.error, ...(out.message ? { message: out.message } : {}), ...(out.detail ?? {}) });
    vmetric('room_evidence_requested');
    res.status(201).json({ suggestion: out.suggestion, routedTo: out.routedTo, note: 'Routed through the standing evidence-request rules, including guardian routing for under-18s.' });
  });

  /** Request standardized Combine protocols through the Combine's creator. */
  orgRouter.post('/rooms/:id/combine-requests', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    if (!requireCan(req, res, room, 'request_combine')) return;
    if (!ctx.createCombineRequests) return res.status(503).json({ error: 'COMBINE_UNAVAILABLE' });
    if (req.org.type === 'agency') return res.status(403).json({ error: 'AGENCY_NOT_ELIGIBLE' });
    if (!req.org.verified) return res.status(403).json({ error: 'ORG_NOT_ELIGIBLE', message: 'Only a verified organisation can create a Club Combine.' });
    if (limited('room_combine_request', req.org.id)) return res.status(429).json(rateLimitedBody('room_combine_request'));

    // Refused, not coerced: protocol ids are text, the title text, the deadline a real day.
    const { protocolIds, title = null, deadline = null } = req.body ?? {};
    if (protocolIds !== undefined && (!Array.isArray(protocolIds) || protocolIds.some((x) => typeof x !== 'string'))) return res.status(400).json({ error: 'FIELD_INVALID', field: 'protocolIds', message: 'protocolIds is a list of protocol ids.' });
    if (title !== null && typeof title !== 'string') return res.status(400).json({ error: 'FIELD_INVALID', field: 'title', message: 'A title is text.' });
    if (!isAbsent(deadline) && !parseStrictDateOnly(deadline).ok) return res.status(400).json({ error: 'DATE_INVALID', field: 'deadline', message: 'A deadline is a calendar day written YYYY-MM-DD.', expected: 'YYYY-MM-DD' });
    const ids = Array.isArray(protocolIds) ? [...new Set(protocolIds)] : [];
    if (!ids.length) return res.status(400).json({ error: 'PROTOCOLS_REQUIRED' });
    if (ids.length > 20) return res.status(400).json({ error: 'FIELD_INVALID', field: 'protocolIds', message: 'A Club Combine asks for at most 20 protocols.' });
    // Protocols are selected from the standardized registry. A room can never
    // invent one or change one's rules.
    for (const pid of ids) if (!ctx.combineProtocolActive?.(pid)) return res.status(404).json({ error: 'PROTOCOL_UNKNOWN', protocolId: pid });
    const instructions = req.body?.instructions ? String(req.body.instructions) : null;
    if (instructions && !moderateOrRefuse(res, instructions, { kind: 'combine_request', orgId: req.org.id })) return;

    // One unit: the request, its ledger row and notification, and the Room's activity.
    const out = unit(() => {
      const o = ctx.createCombineRequests({
        org: req.org, orgUser: req.orgUser, playerIds: [room.playerId],
        protocolIds: ids, title, deadline: isAbsent(deadline) ? null : deadline, instructions,
      });
      if (o.created.length) cases.recordAct(room.id, touched(activity(req, 'room_combine_requested', { requestId: o.created[0].id, protocols: ids })));
      return o;
    });
    if (!out.created.length) return res.status(409).json({ error: 'NOT_VISIBLE', skipped: out.skipped });
    vmetric('room_combine_requested');
    res.status(201).json({ request: ctx.combineRequestView?.(out.created[0]) ?? out.created[0] });
  });

  /**
   * Link a canonical record to this room. Trials, contact requests and signings
   * are created by their own workflows — the Room references them, exactly as
   * cases already do, so there is never a duplicate trial or signing row.
   */
  orgRouter.post('/rooms/:id/link', (req, res) => {
    const room = findRoom(req, res);
    if (!room) return;
    if (!requireCan(req, res, room, 'assign')) return;
    const { trialId, signingId, requestId } = req.body ?? {};
    // Every reference is checked before anything is written.
    const foundTrial = trialId ? reads.trials.byId(trialId) : null;
    const t = foundTrial && foundTrial.orgId === req.org.id && foundTrial.playerId === room.playerId ? foundTrial : null;
    if (trialId && !t) return res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
    const foundRequest = requestId ? reads.requests.byId(requestId) : null;
    const r = foundRequest && foundRequest.orgId === req.org.id && foundRequest.playerId === room.playerId ? foundRequest : null;
    if (requestId && !r) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
    const found = signingId ? reads.signings.byId(signingId) : null;
    const sg = found && found.orgId === req.org.id && found.playerId === room.playerId ? found : null;
    if (signingId && !sg) return res.status(404).json({ error: 'SIGNING_NOT_FOUND' });
    const fresh = cases.link(room.id, { trialId: t?.id, requestId: r?.id, signingId: sg?.id }, touched(
      ...(t ? [activity(req, 'room_trial_linked', { trialId: t.id, status: t.status })] : []),
      ...(sg ? [activity(req, 'room_signing_linked', { signingId: sg.id })] : []),
    ));
    if (t) vmetric('room_trial_requested');
    res.json({ links: fresh.links });
  });

  /** Organisation-private recruitment funnel. No cross-club comparison exists. */
  orgRouter.get('/rooms-funnel', (req, res) => {
    res.json(roomFunnelFromCounts(reads.cases.roomStatusCounts(req.org.id)));
  });

  // ------------------------------------------------------------------ T&S

  /**
   * Trust & Safety does NOT browse club decision rooms. This surface reports
   * platform-level counts and nothing from inside any room: no status, no
   * comment, no decision, no reason, no player and no organisation.
   */
  adminRouter.get('/rooms/overview', (req, res) => {
    const counts = ctx.recruitmentCases.counts();
    res.json({
      rooms: reads.cases.roomCount(), comments: counts.roomComments, decisions: counts.roomDecisions, snapshots: counts.roomSnapshots,
      note: 'Recruitment Rooms are private to the organisation that owns them. Trust & Safety has no routine read access to their contents — an investigation needs an explicit, audited, reasoned support grant.',
    });
  });

  // ------------------------------------------- legacy stage route alignment
  //
  // There is deliberately no stage → status bridge here. `roomStatusForStage`
  // is the inverse of a lossy projection (eighteen statuses onto six stages),
  // so `decision` alone means any of four statuses and a bridge would move a
  // room at `offer_made` backwards — past the transition table, the evidence
  // gate, the history append and the rev bump. `POST /org/cases/:id/stage`
  // refuses a Room and names the lifecycle route instead; `statusMove` stays
  // the only writer.
}
