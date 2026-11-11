// Assignments and challenges don't widen access: every org action passes the standing gates (visibleToOrg with the
// agency/minor wall and grassroots radius, blocks, verified, not suspended). Agencies cannot assign Box Training.
import { isAdult, visibleToOrg } from '../../../domain.mjs';
import { isAbsent, parseStrictDateOnly } from '../../../temporal.mjs';
import { CHALLENGE_METRICS, DISPUTE_OUTCOMES, boxCamInput } from './schemas.mjs';
import { challengeProgress, developmentActivity, fmtMs, TERMINAL_STATES, pageNewestFirst } from './shared.mjs';
import { latestDrill, DRILLS } from './drills.mjs';
import { readPage, pageOf, sendPageError, encodeCursor } from '../../platform/paging.mjs';

export function registerBoxTraining(ctx) {
  const {
    byId,
    playerRouter,
    guardianRouter,
    orgRouter,
    adminRouter,
    nextId,
    notify,
    ledgerAppend,
    findPlayer,
    isBlocked,
    vmetric,
    moderateOrRefuse,
    broadcast,
    boxCam,
    boxCamReads: reads,
    unit,
  } = ctx;

  const orgCanSee = (org, p) => !!p && visibleToOrg(p, org) && !isBlocked(p.id, org.id);
  const guardianOwnsChild = (g, id) => g.childIds.includes(id);
  const drillsById = new Map(DRILLS.map((d) => [d.id, d]));
  const standing = (s) => TERMINAL_STATES.has(s.status) && !['cancelled', 'invalidated'].includes(s.verificationState);

  // Reading the preferences never creates a row; a player who never saved has the defaults.
  const prefsFor = (playerId) => reads.prefs.forPlayer(playerId);
  ctx.boxPrefsFor = prefsFor;

  // ----------------------------------------------------------- assignments
  const assignmentView = (a) => {
    const sessions = reads.sessions.forAssignment(a.id).filter(standing);
    const best = sessions.sort((x, y) => (y.verifiedActiveMs ?? 0) - (x.verifiedActiveMs ?? 0))[0] ?? null;
    return {
      id: a.id,
      playerId: a.playerId,
      orgId: a.orgId,
      orgName: a.orgName,
      assignedBy: a.assignedBy,
      drillId: a.drillId,
      drillTitle: latestDrill(a.drillId)?.title ?? a.drillId,
      target: a.target,
      frequencyPerWeek: a.frequencyPerWeek ?? null,
      dueDate: a.dueDate ?? null,
      instructions: a.instructions ?? null,
      objectiveId: a.objectiveId ?? null,
      state: a.state,
      createdAt: a.createdAt,
      sessionsCompleted: sessions.length,
      lastResult: best
        ? {
            verifiedActiveMs: best.verifiedActiveMs,
            verifiedActive: fmtMs(best.verifiedActiveMs ?? 0),
            verifiedReps: best.verifiedReps ?? null,
            targetCompleted: best.targetCompleted,
            verificationState: best.verificationState,
            statusLabel: best.targetCompleted === true ? 'Completed' : 'Target not yet completed',
          }
        : null,
    };
  };
  ctx.boxAssignmentView = assignmentView;

  orgRouter.get('/box-cam/drills', (_req, res) => res.json({ drills: ctx.drillList() }));

  orgRouter.post('/box-cam/assignments', (req, res) => {
    const body = boxCamInput(res, 'assignment', req.body);
    if (!body) return;
    if (req.org.type === 'agency')
      return res.status(403).json({ error: 'AGENCY_NOT_ELIGIBLE', message: 'Agencies cannot assign Box Training.' });
    if (req.org.suspended) return res.status(403).json({ error: 'ORG_SUSPENDED' });
    if (!req.org.verified)
      return res
        .status(403)
        .json({ error: 'ORG_NOT_ELIGIBLE', message: 'Only a verified organisation can assign Box Training.' });
    const p = body.playerId ? findPlayer(body.playerId) : null;
    if (!p || !orgCanSee(req.org, p)) {
      return res.status(p ? 403 : 404).json({
        error: p ? (req.org.type === 'agency' && !isAdult(p) ? 'UNDER_18_WALL' : 'NOT_VISIBLE') : 'PLAYER_NOT_FOUND',
      });
    }
    const drill = latestDrill(body.drillId ?? '');
    if (!drill)
      return res
        .status(404)
        .json({ error: 'DRILL_UNKNOWN', message: 'Only supported Box Cam drills can be assigned as Box Training.' });
    const t = body.target ?? {};
    if (
      !drill.targetTypes.includes(t.type) ||
      typeof t.value !== 'number' ||
      !Number.isFinite(t.value) ||
      t.value <= 0
    ) {
      return res.status(400).json({ error: 'TARGET_INVALID', allowed: drill.targetTypes });
    }
    const { frequencyPerWeek: freq, dueDate: due, instructions } = body;
    if (
      instructions &&
      !moderateOrRefuse(res, instructions, { kind: 'box_assignment', orgId: req.org.id, playerId: p.id })
    )
      return;
    let objectiveId = null;
    if (body.objectiveId) {
      const found = ctx.developmentReads.objectives.byId(body.objectiveId);
      const obj = found && found.playerId === p.id && found.orgId === req.org.id ? found : null;
      if (!obj) return res.status(404).json({ error: 'OBJECTIVE_NOT_FOUND' });
      objectiveId = obj.id;
    }
    const at = Date.now();
    const a = {
      id: nextId('boxa'),
      playerId: p.id,
      orgId: req.org.id,
      orgName: req.org.name,
      assignedBy: {
        userId: req.orgUser.id,
        name: req.orgUser.name,
        role: req.orgUser.role ?? null,
        orgVerifiedAtAssignment: true,
        at,
      },
      drillId: drill.id,
      drillVersion: drill.version,
      target: { type: t.type, value: t.value },
      frequencyPerWeek: isAbsent(freq) ? null : freq,
      dueDate: isAbsent(due) ? null : parseStrictDateOnly(due).value,
      instructions: instructions || null,
      objectiveId,
      state: 'assigned',
      createdAt: at,
      updatedAt: at,
    };
    const stored = unit(() => {
      const row = boxCam.assignments.create(a);
      ledgerAppend({
        type: 'box_assignment_created',
        playerId: p.id,
        orgId: req.org.id,
        orgName: req.org.name,
        userId: req.orgUser.id,
        scoutName: req.orgUser.name,
        detail: { drillId: drill.id, target: a.target },
      });
      if (!isAdult(p) && p.guardianId)
        notify(
          { kind: 'guardian', id: p.guardianId },
          'box_cam',
          `${req.org.name} assigned ${p.name} Box Training: ${drill.title}.`,
          a.id,
        );
      else
        notify(
          { kind: 'player', id: p.id },
          'box_cam',
          `${req.org.name} assigned you Box Training: ${drill.title}. Train in the Box.`,
          a.id,
        );
      return row;
    });
    vmetric('box_assignment_created');
    res.status(201).json({ assignment: assignmentView(stored) });
  });

  orgRouter.get('/box-cam/assignments', (req, res) => {
    const query = boxCamInput(res, 'orgList', req.query, 'query');
    if (!query) return;
    // A block or visibility change after assignment hides the player again.
    const mine = reads.assignments.forOrg(req.org.id, { playerId: query.playerId || null }).filter((a) => {
      const p = findPlayer(a.playerId);
      return p && orgCanSee(req.org, p);
    });
    const page = pageNewestFirst(query, res, mine, { readPage, pageOf, sendPageError });
    if (!page) return;
    res.json({
      items: page.items.map(assignmentView),
      nextCursor: page.nextCursor,
      summary: {
        assigned: mine.length,
        completed: mine.filter((a) => a.state === 'completed').length,
        partial: mine.filter((a) => a.state === 'partially_completed').length,
        notStarted: mine.filter((a) => ['assigned', 'accepted'].includes(a.state)).length,
      },
      note: 'Coaches receive Box Session results. Raw home footage is never captured or shared by Box Cam.',
    });
  });

  orgRouter.post('/box-cam/assignments/:id/cancel', (req, res) => {
    if (!boxCamInput(res, 'none', req.body)) return;
    const a = reads.assignments.byId(req.params.id);
    if (!a || a.orgId !== req.org.id) return res.status(404).json({ error: 'ASSIGNMENT_NOT_FOUND' });
    if (a.state === 'cancelled') return res.status(409).json({ error: 'ALREADY_CANCELLED' });
    const next = unit(() => {
      const row = boxCam.assignments.cancel(a.id, { at: Date.now() });
      ledgerAppend({
        type: 'box_assignment_cancelled',
        playerId: a.playerId,
        orgId: req.org.id,
        orgName: req.org.name,
        userId: req.orgUser.id,
        scoutName: req.orgUser.name,
        detail: { assignmentId: a.id },
      });
      return row;
    });
    res.json({ assignment: assignmentView(next) });
  });

  const accept = (a) => boxCam.assignments.accept(a.id, { at: Date.now() });
  playerRouter.get('/box-cam/assignments', (req, res) => {
    res.json({ items: reads.assignments.forPlayer(req.player.id).map(assignmentView) });
  });
  playerRouter.post('/box-cam/assignments/:id/accept', (req, res) => {
    if (!boxCamInput(res, 'none', req.body)) return;
    const a = reads.assignments.byId(req.params.id);
    if (!a || a.playerId !== req.player.id) return res.status(404).json({ error: 'ASSIGNMENT_NOT_FOUND' });
    if (!isAdult(req.player))
      return res
        .status(403)
        .json({ error: 'GUARDIAN_MANAGED', message: 'Your parent/guardian accepts club-assigned training.' });
    if (a.state !== 'assigned') return res.status(409).json({ error: 'NOT_ACCEPTABLE', state: a.state });
    res.json({ assignment: assignmentView(accept(a)) });
  });
  guardianRouter.get('/children/:id/box-cam/assignments', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    res.json({ items: reads.assignments.forPlayer(req.params.id).map(assignmentView) });
  });
  guardianRouter.post('/children/:id/box-cam/assignments/:aid/accept', (req, res) => {
    if (!boxCamInput(res, 'none', req.body)) return;
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const a = reads.assignments.byId(req.params.aid);
    if (!a || a.playerId !== req.params.id) return res.status(404).json({ error: 'ASSIGNMENT_NOT_FOUND' });
    if (a.state !== 'assigned') return res.status(409).json({ error: 'NOT_ACCEPTABLE', state: a.state });
    res.json({ assignment: assignmentView(accept(a)) });
  });

  /** Runs inside the completion's unit of work. */
  function applyAssignmentProgress(session) {
    if (!session.assignmentId) return;
    const a = reads.assignments.byId(session.assignmentId);
    if (!a || a.state === 'cancelled') return;
    if (!['verified', 'partially_verified'].includes(session.verificationState)) return;
    let next = a.state;
    if (session.targetCompleted === true) {
      const done = reads.sessions
        .forAssignment(a.id)
        .filter(
          (s) => s.targetCompleted === true && !['cancelled', 'invalidated'].includes(s.verificationState),
        ).length;
      next = a.frequencyPerWeek && done < a.frequencyPerWeek ? 'in_progress' : 'completed';
    } else if (a.state === 'assigned' || a.state === 'accepted') {
      next = session.verifiedActiveMs > 0 ? 'partially_completed' : 'in_progress';
    }
    boxCam.assignments.progress(a.id, { state: next, at: Date.now() });
    if (session.targetCompleted === true && next === 'completed') {
      vmetric('box_assignment_completed');
      const p = findPlayer(a.playerId);
      const lead = byId.user(a.assignedBy.userId, (u) => !u.removedAt);
      if (lead && p)
        notify(
          { kind: 'org_user', id: lead.id },
          'box_cam',
          `${p.name} completed Box Training: ${latestDrill(a.drillId)?.title ?? a.drillId} (${session.verifiedReps != null ? `${session.verifiedReps} verified` : fmtMs(session.verifiedActiveMs)}).`,
          a.id,
        );
    }
  }

  // ------------------------------------------------------------ challenges
  const challengeView = (c, entry = null, participants = null) => ({
    id: c.id,
    title: c.title,
    publisher: c.publisher,
    drillId: c.drillId,
    drillTitle: latestDrill(c.drillId)?.title ?? c.drillId,
    metric: c.metric,
    targetTotal: c.targetTotal,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    adultOnly: !!c.adultOnly,
    cap: c.cap ?? null,
    participants: participants ?? reads.entries.countFor(c.id),
    entry: entry
      ? {
          id: entry.id,
          status: entry.status,
          progress: entry.progress,
          joinedAt: entry.joinedAt,
          completedAt: entry.completedAt ?? null,
        }
      : null,
    disclaimer:
      'Completing a Box Challenge does not mean the club has scouted, selected or endorsed you unless explicitly stated through a separate ScoutBox recruitment workflow.',
  });

  function eligibleChallenges(player) {
    return reads.challenges.open(Date.now()).filter((c) => {
      if (c.adultOnly && !isAdult(player)) return false;
      if (c.publisher.kind === 'org') {
        const org = byId.org(c.publisher.orgId);
        // If the publishing org may not see this player, the player doesn't see the challenge.
        if (!org || org.suspended || !orgCanSee(org, player)) return false;
      }
      return true;
    });
  }

  orgRouter.post('/box-cam/challenges', (req, res) => {
    const body = boxCamInput(res, 'challenge', req.body);
    if (!body) return;
    if (req.org.type === 'agency') return res.status(403).json({ error: 'AGENCY_NOT_ELIGIBLE' });
    if (req.org.suspended) return res.status(403).json({ error: 'ORG_SUSPENDED' });
    if (!req.org.verified)
      return res
        .status(403)
        .json({ error: 'ORG_NOT_ELIGIBLE', message: 'Only a verified organisation can publish a Box Challenge.' });
    const { title, drillId, metric, targetTotal, days, adultOnly, cap } = body;
    const drill = latestDrill(drillId ?? '');
    if (!drill) return res.status(404).json({ error: 'DRILL_UNKNOWN' });
    if (!metric)
      return res
        .status(400)
        .json({ error: 'METRIC_INVALID', field: 'metric', problem: 'required', allowed: CHALLENGE_METRICS });
    if (metric === 'reps' && !drill.verificationCapabilities.includes('rep_count')) {
      return res.status(400).json({
        error: 'METRIC_NOT_SUPPORTED',
        message: `${drill.title} cannot verify repetition counts — use active_minutes.`,
      });
    }
    if (targetTotal === undefined)
      return res.status(400).json({ error: 'TARGET_INVALID', field: 'targetTotal', problem: 'required' });
    if (!moderateOrRefuse(res, title ?? '', { kind: 'box_challenge', orgId: req.org.id })) return;
    const at = Date.now();
    const c = {
      id: nextId('boxc'),
      title: (title ?? '').trim() || `${drill.title} Box Challenge`,
      publisher: { kind: 'org', orgId: req.org.id, orgName: req.org.name, byName: req.orgUser.name },
      drillId: drill.id,
      metric,
      targetTotal,
      startsAt: at,
      endsAt: at + (isAbsent(days) ? 14 : days) * 86_400_000,
      adultOnly: adultOnly === true,
      cap: isAbsent(cap) ? null : cap,
      status: 'active',
      createdAt: at,
    };
    const stored = unit(() => {
      const row = boxCam.challenges.create(c);
      ledgerAppend({
        type: 'box_challenge_published',
        playerId: null,
        orgId: req.org.id,
        orgName: req.org.name,
        userId: req.orgUser.id,
        scoutName: req.orgUser.name,
        detail: { challengeId: c.id, drillId: c.drillId },
      });
      return row;
    });
    res.status(201).json({ challenge: challengeView(stored) });
  });

  orgRouter.get('/box-cam/challenges', (req, res) => {
    const query = boxCamInput(res, 'page', req.query, 'query');
    if (!query) return;
    const page = pageNewestFirst(query, res, reads.challenges.forOrg(req.org.id), { readPage, pageOf, sendPageError });
    if (!page) return;
    const counts = reads.challenges.participants(page.items.map((c) => c.id));
    res.json({ items: page.items.map((c) => challengeView(c, null, counts.get(c.id))), nextCursor: page.nextCursor });
  });

  playerRouter.get('/box-cam/challenges', (req, res) => {
    const entries = reads.entries.forPlayer(req.player.id);
    const list = eligibleChallenges(req.player);
    const counts = reads.challenges.participants(list.map((c) => c.id));
    res.json({
      items: list.map((c) => challengeView(c, entries.find((e) => e.challengeId === c.id) ?? null, counts.get(c.id))),
    });
  });

  function joinChallenge(res, player, challengeId, by) {
    const c = eligibleChallenges(player).find((x) => x.id === challengeId);
    if (!c) return res.status(404).json({ error: 'CHALLENGE_NOT_FOUND' });
    if (reads.entries.forPlayer(player.id).some((e) => e.challengeId === c.id)) {
      return res.status(409).json({ error: 'ALREADY_JOINED' });
    }
    if (c.cap && reads.entries.countFor(c.id) >= c.cap) {
      return res.status(409).json({ error: 'CHALLENGE_FULL' });
    }
    const entry = boxCam.entries.create({
      id: nextId('boxe'),
      challengeId: c.id,
      playerId: player.id,
      status: 'active',
      progress: 0,
      joinedAt: Date.now(),
      joinedBy: by,
      completedAt: null,
    });
    vmetric('box_challenge_started');
    res.status(201).json({ challenge: challengeView(c, entry) });
  }
  playerRouter.post('/box-cam/challenges/:id/join', (req, res) => {
    if (!boxCamInput(res, 'none', req.body)) return;
    if (!isAdult(req.player))
      return res
        .status(403)
        .json({ error: 'GUARDIAN_MANAGED', message: 'Your parent/guardian approves Box Challenge participation.' });
    joinChallenge(res, req.player, req.params.id, { kind: 'player', id: req.player.id });
  });
  guardianRouter.post('/children/:id/box-cam/challenges/:cid/join', (req, res) => {
    if (!boxCamInput(res, 'none', req.body)) return;
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    joinChallenge(res, child, req.params.cid, { kind: 'guardian', id: req.guardian.id });
  });

  /** Runs inside the completion's unit of work. */
  function applyChallengeProgress(session, player) {
    const entries = reads.entries.forPlayer(session.playerId).filter((e) => e.status === 'active');
    if (!entries.length) return;
    const sessions = reads.sessions.finishedForPlayer(session.playerId);
    for (const entry of entries) {
      const c = reads.challenges.byId(entry.challengeId);
      if (!c || c.drillId !== session.drillId) continue;
      const prog = challengeProgress(c, sessions);
      const completes = prog.completed;
      boxCam.entries.progress(entry.id, { progress: prog.total, completedAt: completes ? Date.now() : null });
      if (completes) {
        vmetric('box_challenge_completed');
        notify(
          { kind: 'player', id: player.id },
          'box_cam',
          `Box Challenge complete: ${c.title}. Your work counts.`,
          entry.id,
        );
        broadcast('player_development_evidence_changed', { playerId: player.id });
      }
    }
  }

  ctx.onSessionFinalized = (session, player) => {
    applyAssignmentProgress(session);
    applyChallengeProgress(session, player);
  };

  // -------------------------------------------------------- development plan
  function developmentPlan(player) {
    const objectives = ctx.developmentReads.objectives.forPlayer(player.id);
    const assignments = reads.assignments.forPlayer(player.id).filter((a) => a.state !== 'cancelled');
    const sessions = reads.sessions.finishedForPlayer(player.id).filter(standing);
    return {
      objectives: objectives.map((o) => ({
        id: o.id,
        orgId: o.orgId,
        orgName: byId.org(o.orgId)?.name ?? null,
        status: o.status,
        createdAt: o.createdAt,
        objectives: (o.objectives ?? []).map((x) => x.text),
        assignments: assignments.filter((a) => a.objectiveId === o.id).map(assignmentView),
      })),
      assignments: assignments.map(assignmentView),
      activity: developmentActivity({ sessions, assignments, drillsById, days: 30 }),
      note: 'Completing sessions never automatically marks a development objective achieved — objectives close through their own existing flow.',
    };
  }
  playerRouter.get('/box-cam/development-plan', (req, res) => res.json(developmentPlan(req.player)));
  guardianRouter.get('/children/:id/box-cam/development-plan', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    res.json(developmentPlan(child));
  });

  // ---------------------------------------------------------------- prefs
  const prefsView = (p) => ({
    playerId: p.playerId,
    shareDevelopmentActivity: p.shareDevelopmentActivity,
    retainClips: p.retainClips,
    updatedAt: p.updatedAt,
    updatedBy: p.updatedBy,
  });
  function applyPrefs(res, player, input, by) {
    const body = boxCamInput(res, 'prefs', input);
    if (!body) return;
    const current = prefsFor(player.id);
    const next = {
      playerId: player.id,
      shareDevelopmentActivity: body.shareDevelopmentActivity ?? current.shareDevelopmentActivity,
      retainClips: body.retainClips ?? current.retainClips,
      updatedAt: Date.now(),
      updatedBy: { kind: by.kind, id: by.id },
    };
    const saved = unit(() => {
      const row = boxCam.prefs.save(next);
      ledgerAppend({
        type: 'box_prefs_changed',
        playerId: player.id,
        orgId: null,
        detail: { by: by.kind, share: row.shareDevelopmentActivity, retainClips: row.retainClips },
      });
      return row;
    });
    res.json({ prefs: prefsView(saved) });
  }
  playerRouter.get('/box-cam/prefs', (req, res) => res.json({ prefs: prefsView(prefsFor(req.player.id)) }));
  playerRouter.patch('/box-cam/prefs', (req, res) => {
    if (!isAdult(req.player))
      return res
        .status(403)
        .json({ error: 'GUARDIAN_MANAGED', message: 'Your parent/guardian manages Box Cam privacy settings.' });
    applyPrefs(res, req.player, req.body, { kind: 'player', id: req.player.id });
  });
  guardianRouter.patch('/children/:id/box-cam/prefs', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    applyPrefs(res, child, req.body, { kind: 'guardian', id: req.guardian.id });
  });

  // -------------------------------------------------------------- disputes
  const disputeView = (d) => ({
    id: d.id,
    sessionId: d.sessionId,
    playerId: d.playerId,
    by: d.by,
    reason: d.reason,
    status: d.status,
    resolution: d.resolution,
    createdAt: d.createdAt,
  });
  const disputeWindows = new Map();
  function fileDispute(res, player, sessionId, input, by) {
    const body = boxCamInput(res, 'dispute', input);
    if (!body) return;
    const now = Date.now();
    const w = disputeWindows.get(player.id);
    if (w && w.resetAt > now && w.count >= 5) return res.status(429).json({ error: 'RATE_LIMITED' });
    disputeWindows.set(
      player.id,
      w && w.resetAt > now ? { count: w.count + 1, resetAt: w.resetAt } : { count: 1, resetAt: now + 86_400_000 },
    );
    const s = reads.sessions.byId(sessionId);
    if (!s || s.playerId !== player.id || !TERMINAL_STATES.has(s.status))
      return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    const text = (body.reason ?? '').trim();
    if (!text) return res.status(400).json({ error: 'REASON_REQUIRED', field: 'reason', problem: 'required' });
    if (!moderateOrRefuse(res, text, { kind: 'box_dispute', playerId: player.id })) return;
    const d = boxCam.disputes.create({
      id: nextId('boxd'),
      sessionId: s.id,
      playerId: player.id,
      by,
      reason: text,
      status: 'open',
      resolution: null,
      createdAt: now,
    });
    res.status(201).json({
      dispute: disputeView(d),
      note: 'Trust & Safety reviews Box Cam disputes. Verified results are never edited by hand — they can be invalidated or restored, not invented.',
    });
  }
  playerRouter.post('/box-cam/sessions/:id/dispute', (req, res) =>
    fileDispute(res, req.player, req.params.id, req.body, {
      kind: 'player',
      id: req.player.id,
      name: req.player.name,
    }),
  );
  guardianRouter.post('/children/:id/box-cam/sessions/:sid/dispute', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    fileDispute(res, child, req.params.sid, req.body, {
      kind: 'guardian',
      id: req.guardian.id,
      name: req.guardian.name,
    });
  });

  // ------------------------------------------------------------------ T&S
  // The queue grows with the platform: one page, oldest first.
  adminRouter.get('/box-cam/disputes', (req, res) => {
    const query = boxCamInput(res, 'disputeQueue', req.query, 'query');
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number', 'string']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const rows = reads.disputes.queue({ all: query.all === '1', after: page.after, limit: page.limit + 1 });
    const items = rows.slice(0, page.limit);
    const sessions = new Map(reads.sessions.byIds(items.map((d) => d.sessionId)).map((s) => [s.id, s]));
    res.json({
      items: items.map((d) => ({
        ...disputeView(d),
        session: ctx.boxSessionView(sessions.get(d.sessionId) ?? {}, { includeIntegrity: true }),
      })),
      nextCursor:
        rows.length > page.limit ? encodeCursor([items[items.length - 1].createdAt, items[items.length - 1].id]) : null,
    });
  });
  adminRouter.post('/box-cam/disputes/:id/resolve', (req, res) => {
    const d = reads.disputes.byId(req.params.id);
    if (!d) return res.status(404).json({ error: 'DISPUTE_NOT_FOUND' });
    if (d.status !== 'open') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    const body = boxCamInput(res, 'resolve', req.body);
    if (!body) return;
    const { outcome } = body;
    const reason = (body.reason ?? '').trim();
    if (!outcome)
      return res
        .status(400)
        .json({ error: 'OUTCOME_REQUIRED', field: 'outcome', problem: 'required', allowed: DISPUTE_OUTCOMES });
    if (!reason) return res.status(400).json({ error: 'REASON_REQUIRED', field: 'reason', problem: 'required' });
    const s = reads.sessions.byId(d.sessionId);
    const resolved = unit(() => {
      // A session with no result (it expired before it started) or one already invalidated has nothing to invalidate:
      // the dispute is resolved and the session left as it is.
      if (
        (outcome === 'invalidated' || outcome === 'provider_bug') &&
        s &&
        s.verificationState &&
        s.verificationState !== 'invalidated'
      ) {
        // The session's integrity history is append-only, so a later restore never erases the fact or the moment of
        // invalidation.
        boxCam.sessions.invalidate(s.id, { at: Date.now(), disputeId: d.id, outcome });
        ledgerAppend({
          type: 'box_result_invalidated',
          playerId: s.playerId,
          orgId: null,
          detail: { sessionId: s.id, disputeId: d.id, outcome },
        });
      }
      const row = boxCam.disputes.resolve(d.id, {
        outcome,
        reason,
        at: Date.now(),
      });
      const target = d.by.kind === 'guardian' ? { kind: 'guardian', id: d.by.id } : { kind: 'player', id: d.playerId };
      notify(
        target,
        'box_cam',
        `Trust & Safety resolved your Box Cam dispute: ${outcome === 'stands' ? 'the result stands' : 'the result was invalidated'}.`,
        d.id,
      );
      return row;
    });
    res.json({ dispute: disputeView(resolved) });
  });
  adminRouter.post('/box-cam/sessions/:id/restore', (req, res) => {
    const body = boxCamInput(res, 'restore', req.body);
    if (!body) return;
    const s = reads.sessions.byId(req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (s.verificationState !== 'invalidated' || !s.previousVerificationState)
      return res.status(409).json({ error: 'NOT_INVALIDATED' });
    const reason = (body.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'REASON_REQUIRED', field: 'reason', problem: 'required' });
    const restored = unit(() => {
      const row = boxCam.sessions.restore(s.id, { at: Date.now() });
      ledgerAppend({
        type: 'box_result_restored',
        playerId: s.playerId,
        orgId: null,
        detail: { sessionId: s.id, reason },
      });
      return row;
    });
    res.json({ session: ctx.boxSessionView(restored) });
  });

  // The ScoutBox challenges are seeded by a migration, not at boot.

  return { assignmentView, challengeView, developmentPlan };
}
