// M16 — Box Training: coach assignments, the Development Plan, Box
// Challenges, disputes and Trust & Safety tooling.
//
// Assignments and challenges NEVER widen access: every org action passes
// the standing gates (visibleToOrg incl. the agency/minor wall and the
// grassroots radius, blocks, verified organisation, not suspended).
// Agencies cannot assign Box Training at all. Coaches receive session
// RESULTS, never raw home footage — no such footage exists server-side.
import { isAdult, visibleToOrg } from '../domain.mjs';
import { challengeProgress, developmentActivity, fmtMs, TERMINAL_STATES } from './shared.mjs';
import { latestDrill, DRILLS } from './drills.mjs';

export function registerBoxTraining(ctx) {
  const {
    db, playerRouter, guardianRouter, orgRouter, adminRouter, nextId,
    persistNow, notify, ledgerAppend, findPlayer, isBlocked, vmetric,
    moderateOrRefuse, broadcast,
  } = ctx;

  const orgCanSee = (org, p) => !!p && visibleToOrg(p, org) && !isBlocked(p.id, org.id);
  const guardianOwnsChild = (g, id) => g.childIds.includes(id);
  const drillsById = new Map(DRILLS.map((d) => [d.id, d]));

  const prefsFor = (playerId) => {
    let p = db.boxCamPrefs.find((x) => x.playerId === playerId);
    if (!p) {
      p = { playerId, shareDevelopmentActivity: 'private', retainClips: false, updatedAt: null, updatedBy: null };
      db.boxCamPrefs.push(p);
    }
    return p;
  };
  ctx.boxPrefsFor = prefsFor;

  // ----------------------------------------------------------- assignments
  const assignmentView = (a) => {
    const sessions = db.boxSessions.filter((s) => s.assignmentId === a.id && TERMINAL_STATES.has(s.status) && !['cancelled', 'invalidated'].includes(s.verificationState));
    const best = sessions.sort((x, y) => (y.verifiedActiveMs ?? 0) - (x.verifiedActiveMs ?? 0))[0] ?? null;
    return {
      id: a.id, playerId: a.playerId, orgId: a.orgId, orgName: a.orgName,
      assignedBy: a.assignedBy, drillId: a.drillId, drillTitle: latestDrill(a.drillId)?.title ?? a.drillId,
      target: a.target, frequencyPerWeek: a.frequencyPerWeek ?? null, dueDate: a.dueDate ?? null,
      instructions: a.instructions ?? null, objectiveId: a.objectiveId ?? null,
      state: a.state, createdAt: a.createdAt,
      sessionsCompleted: sessions.length,
      lastResult: best ? {
        verifiedActiveMs: best.verifiedActiveMs, verifiedActive: fmtMs(best.verifiedActiveMs ?? 0),
        verifiedReps: best.verifiedReps ?? null, targetCompleted: best.targetCompleted,
        verificationState: best.verificationState,
        statusLabel: best.targetCompleted === true ? 'Completed' : 'Target not yet completed',
      } : null,
    };
  };
  ctx.boxAssignmentView = assignmentView;

  orgRouter.post('/box-cam/assignments', (req, res) => {
    if (req.org.type === 'agency') return res.status(403).json({ error: 'AGENCY_NOT_ELIGIBLE', message: 'Agencies cannot assign Box Training.' });
    if (req.org.suspended) return res.status(403).json({ error: 'ORG_SUSPENDED' });
    if (!req.org.verified) return res.status(403).json({ error: 'ORG_NOT_ELIGIBLE', message: 'Only a verified organisation can assign Box Training.' });
    const p = findPlayer(req.body?.playerId);
    if (!p || !orgCanSee(req.org, p)) {
      // Concealment semantics identical to the standing rules.
      return res.status(p ? 403 : 404).json({ error: p ? (req.org.type === 'agency' && !isAdult(p) ? 'UNDER_18_WALL' : 'NOT_VISIBLE') : 'PLAYER_NOT_FOUND' });
    }
    const drill = latestDrill(String(req.body?.drillId ?? ''));
    if (!drill) return res.status(404).json({ error: 'DRILL_UNKNOWN', message: 'Only supported Box Cam drills can be assigned as Box Training.' });
    const t = req.body?.target ?? {};
    if (!drill.targetTypes.includes(t.type) || !Number.isFinite(Number(t.value))) {
      return res.status(400).json({ error: 'TARGET_INVALID', allowed: drill.targetTypes });
    }
    if (req.body?.instructions && !moderateOrRefuse(res, String(req.body.instructions), { kind: 'box_assignment', orgId: req.org.id, playerId: p.id })) return;
    let objectiveId = null;
    if (req.body?.objectiveId) {
      const obj = db.devObjectives.find((o) => o.id === req.body.objectiveId && o.playerId === p.id && o.orgId === req.org.id);
      if (!obj) return res.status(404).json({ error: 'OBJECTIVE_NOT_FOUND' });
      objectiveId = obj.id;
    }
    const a = {
      id: nextId('boxa'), playerId: p.id, orgId: req.org.id, orgName: req.org.name,
      assignedBy: { userId: req.orgUser.id, name: req.orgUser.name, role: req.orgUser.role ?? null, orgVerifiedAtAssignment: true, at: Date.now() },
      drillId: drill.id, drillVersion: drill.version,
      target: { type: t.type, value: Number(t.value) },
      frequencyPerWeek: Number(req.body?.frequencyPerWeek) || null,
      dueDate: req.body?.dueDate ? String(req.body.dueDate).slice(0, 10) : null,
      instructions: req.body?.instructions ? String(req.body.instructions).slice(0, 300) : null,
      objectiveId,
      state: 'assigned', createdAt: Date.now(), updatedAt: Date.now(),
    };
    db.boxAssignments.push(a);
    ledgerAppend({ type: 'box_assignment_created', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name, detail: { drillId: drill.id, target: a.target } });
    vmetric('box_assignment_created');
    if (!isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'box_cam', `${req.org.name} assigned ${p.name} Box Training: ${drill.title}.`, a.id);
    else notify({ kind: 'player', id: p.id }, 'box_cam', `${req.org.name} assigned you Box Training: ${drill.title}. Train in the Box.`, a.id);
    persistNow();
    res.status(201).json({ assignment: assignmentView(a) });
  });

  orgRouter.get('/box-cam/assignments', (req, res) => {
    let mine = db.boxAssignments.filter((a) => a.orgId === req.org.id);
    if (req.query.playerId) mine = mine.filter((a) => a.playerId === String(req.query.playerId));
    // A block or visibility change after assignment hides the player again.
    mine = mine.filter((a) => { const p = findPlayer(a.playerId); return p && orgCanSee(req.org, p); });
    res.json({
      items: mine.map(assignmentView),
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
    const a = db.boxAssignments.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!a) return res.status(404).json({ error: 'ASSIGNMENT_NOT_FOUND' });
    if (['cancelled', 'superseded'].includes(a.state)) return res.status(409).json({ error: 'ALREADY_CANCELLED' });
    a.state = 'cancelled';
    a.updatedAt = Date.now();
    ledgerAppend({ type: 'box_assignment_cancelled', playerId: a.playerId, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name, detail: { assignmentId: a.id } });
    persistNow();
    res.json({ assignment: assignmentView(a) });
  });

  playerRouter.get('/box-cam/assignments', (req, res) => {
    res.json({ items: db.boxAssignments.filter((a) => a.playerId === req.player.id).map(assignmentView) });
  });
  playerRouter.post('/box-cam/assignments/:id/accept', (req, res) => {
    const a = db.boxAssignments.find((x) => x.id === req.params.id && x.playerId === req.player.id);
    if (!a) return res.status(404).json({ error: 'ASSIGNMENT_NOT_FOUND' });
    if (!isAdult(req.player)) return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Your parent/guardian accepts club-assigned training.' });
    if (a.state !== 'assigned') return res.status(409).json({ error: 'NOT_ACCEPTABLE', state: a.state });
    a.state = 'accepted';
    a.updatedAt = Date.now();
    persistNow();
    res.json({ assignment: assignmentView(a) });
  });
  guardianRouter.get('/children/:id/box-cam/assignments', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    res.json({ items: db.boxAssignments.filter((a) => a.playerId === req.params.id).map(assignmentView) });
  });
  guardianRouter.post('/children/:id/box-cam/assignments/:aid/accept', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const a = db.boxAssignments.find((x) => x.id === req.params.aid && x.playerId === req.params.id);
    if (!a) return res.status(404).json({ error: 'ASSIGNMENT_NOT_FOUND' });
    if (a.state !== 'assigned') return res.status(409).json({ error: 'NOT_ACCEPTABLE', state: a.state });
    a.state = 'accepted';
    a.updatedAt = Date.now();
    persistNow();
    res.json({ assignment: assignmentView(a) });
  });

  /** Assignment progress from a finalized session — completion only ever
   *  derives from verified values; a near miss stays "partially". */
  function applyAssignmentProgress(session) {
    if (!session.assignmentId) return;
    const a = db.boxAssignments.find((x) => x.id === session.assignmentId);
    if (!a || ['cancelled', 'superseded'].includes(a.state)) return;
    if (!['verified', 'partially_verified'].includes(session.verificationState)) return;
    a.updatedAt = Date.now();
    if (session.targetCompleted === true) {
      const done = db.boxSessions.filter((s) => s.assignmentId === a.id && s.targetCompleted === true && !['cancelled', 'invalidated'].includes(s.verificationState)).length;
      a.state = a.frequencyPerWeek && done < a.frequencyPerWeek ? 'in_progress' : 'completed';
      if (a.state === 'completed') {
        vmetric('box_assignment_completed');
        const p = findPlayer(a.playerId);
        const lead = db.users.find((u) => u.id === a.assignedBy.userId && !u.removedAt);
        if (lead && p) notify({ kind: 'org_user', id: lead.id }, 'box_cam', `${p.name} completed Box Training: ${latestDrill(a.drillId)?.title ?? a.drillId} (${session.verifiedReps != null ? `${session.verifiedReps} verified` : fmtMs(session.verifiedActiveMs)}).`, a.id);
      }
    } else if (a.state === 'assigned' || a.state === 'accepted') {
      a.state = session.verifiedActiveMs > 0 ? 'partially_completed' : 'in_progress';
    }
  }

  // ------------------------------------------------------------ challenges
  const challengeView = (c, entry = null) => ({
    id: c.id, title: c.title, publisher: c.publisher,
    drillId: c.drillId, drillTitle: latestDrill(c.drillId)?.title ?? c.drillId,
    metric: c.metric, targetTotal: c.targetTotal,
    startsAt: c.startsAt, endsAt: c.endsAt,
    adultOnly: !!c.adultOnly, cap: c.cap ?? null,
    participants: db.boxChallengeEntries.filter((e) => e.challengeId === c.id).length,
    entry: entry ? { id: entry.id, status: entry.status, progress: entry.progress, joinedAt: entry.joinedAt, completedAt: entry.completedAt ?? null } : null,
    disclaimer: 'Completing a Box Challenge does not mean the club has scouted, selected or endorsed you unless explicitly stated through a separate ScoutBox recruitment workflow.',
  });

  function eligibleChallenges(player) {
    const now = Date.now();
    return db.boxChallenges.filter((c) => {
      if (c.status !== 'active' || c.endsAt < now) return false;
      if (c.adultOnly && !isAdult(player)) return false;
      if (c.publisher.kind === 'org') {
        const org = db.orgs.find((o) => o.id === c.publisher.orgId);
        // A challenge NEVER bypasses standing visibility: if the publishing
        // org may not see this player, the player never sees the challenge.
        if (!org || org.suspended || !orgCanSee(org, player)) return false;
      }
      return true;
    });
  }

  orgRouter.post('/box-cam/challenges', (req, res) => {
    if (req.org.type === 'agency') return res.status(403).json({ error: 'AGENCY_NOT_ELIGIBLE' });
    if (req.org.suspended) return res.status(403).json({ error: 'ORG_SUSPENDED' });
    if (!req.org.verified) return res.status(403).json({ error: 'ORG_NOT_ELIGIBLE', message: 'Only a verified organisation can publish a Box Challenge.' });
    const { title, drillId, metric, targetTotal, days, adultOnly, cap } = req.body ?? {};
    const drill = latestDrill(String(drillId ?? ''));
    if (!drill) return res.status(404).json({ error: 'DRILL_UNKNOWN' });
    if (!['reps', 'active_minutes'].includes(metric)) return res.status(400).json({ error: 'METRIC_INVALID', allowed: ['reps', 'active_minutes'] });
    if (metric === 'reps' && !drill.verificationCapabilities.includes('rep_count')) {
      return res.status(400).json({ error: 'METRIC_NOT_SUPPORTED', message: `${drill.title} cannot verify repetition counts — use active_minutes.` });
    }
    const total = Number(targetTotal);
    if (!Number.isFinite(total) || total < 1 || total > 100_000) return res.status(400).json({ error: 'TARGET_INVALID' });
    if (!moderateOrRefuse(res, String(title ?? ''), { kind: 'box_challenge', orgId: req.org.id })) return;
    const c = {
      id: nextId('boxc'), title: String(title ?? '').slice(0, 120) || `${drill.title} Box Challenge`,
      publisher: { kind: 'org', orgId: req.org.id, orgName: req.org.name, byName: req.orgUser.name },
      drillId: drill.id, metric, targetTotal: total,
      startsAt: Date.now(), endsAt: Date.now() + (Math.min(Math.max(Number(days) || 14, 1), 60)) * 86_400_000,
      adultOnly: !!adultOnly, cap: Number(cap) > 0 ? Number(cap) : null,
      status: 'active', createdAt: Date.now(),
    };
    db.boxChallenges.push(c);
    ledgerAppend({ type: 'box_challenge_published', playerId: null, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name, detail: { challengeId: c.id, drillId: c.drillId } });
    persistNow();
    res.status(201).json({ challenge: challengeView(c) });
  });

  orgRouter.get('/box-cam/challenges', (req, res) => {
    res.json({ items: db.boxChallenges.filter((c) => c.publisher.kind === 'org' && c.publisher.orgId === req.org.id).map((c) => challengeView(c)) });
  });

  playerRouter.get('/box-cam/challenges', (req, res) => {
    const entries = db.boxChallengeEntries.filter((e) => e.playerId === req.player.id);
    res.json({ items: eligibleChallenges(req.player).map((c) => challengeView(c, entries.find((e) => e.challengeId === c.id) ?? null)) });
  });

  function joinChallenge(res, player, challengeId, by) {
    const c = eligibleChallenges(player).find((x) => x.id === challengeId);
    if (!c) return res.status(404).json({ error: 'CHALLENGE_NOT_FOUND' });
    if (db.boxChallengeEntries.some((e) => e.challengeId === c.id && e.playerId === player.id)) {
      return res.status(409).json({ error: 'ALREADY_JOINED' });
    }
    if (c.cap && db.boxChallengeEntries.filter((e) => e.challengeId === c.id).length >= c.cap) {
      return res.status(409).json({ error: 'CHALLENGE_FULL' });
    }
    const entry = { id: nextId('boxe'), challengeId: c.id, playerId: player.id, status: 'active', progress: 0, sessionIds: [], joinedAt: Date.now(), joinedBy: by, completedAt: null };
    db.boxChallengeEntries.push(entry);
    vmetric('box_challenge_started');
    persistNow();
    res.status(201).json({ challenge: challengeView(c, entry) });
  }
  playerRouter.post('/box-cam/challenges/:id/join', (req, res) => {
    if (!isAdult(req.player)) return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Your parent/guardian approves Box Challenge participation.' });
    joinChallenge(res, req.player, req.params.id, { kind: 'player', id: req.player.id });
  });
  guardianRouter.post('/children/:id/box-cam/challenges/:cid/join', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    joinChallenge(res, child, req.params.cid, { kind: 'guardian', id: req.guardian.id });
  });

  /** Recompute challenge progress deterministically from distinct finalized
   *  sessions — replays cannot double-count, sessions past the end date
   *  never count. */
  function applyChallengeProgress(session, player) {
    const entries = db.boxChallengeEntries.filter((e) => e.playerId === session.playerId && e.status === 'active');
    for (const entry of entries) {
      const c = db.boxChallenges.find((x) => x.id === entry.challengeId);
      if (!c || c.drillId !== session.drillId) continue;
      const sessions = db.boxSessions.filter((s) => s.playerId === session.playerId && TERMINAL_STATES.has(s.status));
      const prog = challengeProgress(c, sessions);
      entry.progress = prog.total;
      entry.sessionIds = prog.sessionIds;
      if (prog.completed && entry.status === 'active') {
        entry.status = 'completed';
        entry.completedAt = Date.now();
        vmetric('box_challenge_completed');
        notify({ kind: 'player', id: player.id }, 'box_cam', `Box Challenge complete: ${c.title}. Your work counts.`, entry.id);
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
    const objectives = db.devObjectives.filter((o) => o.playerId === player.id);
    const assignments = db.boxAssignments.filter((a) => a.playerId === player.id && !['cancelled', 'superseded'].includes(a.state));
    const sessions = db.boxSessions.filter((s) => s.playerId === player.id && TERMINAL_STATES.has(s.status) && !['cancelled', 'invalidated'].includes(s.verificationState));
    return {
      objectives: objectives.map((o) => ({
        id: o.id, orgId: o.orgId, orgName: db.orgs.find((x) => x.id === o.orgId)?.name ?? null,
        status: o.status, createdAt: o.createdAt,
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
  function applyPrefs(res, player, body, by) {
    const p = prefsFor(player.id);
    if (body.shareDevelopmentActivity !== undefined) {
      if (!['private', 'recruitment'].includes(body.shareDevelopmentActivity)) return res.status(400).json({ error: 'SHARE_INVALID', allowed: ['private', 'recruitment'] });
      p.shareDevelopmentActivity = body.shareDevelopmentActivity;
    }
    if (body.retainClips !== undefined) p.retainClips = !!body.retainClips;
    p.updatedAt = Date.now();
    p.updatedBy = by;
    ledgerAppend({ type: 'box_prefs_changed', playerId: player.id, orgId: null, detail: { by: by.kind, share: p.shareDevelopmentActivity, retainClips: p.retainClips } });
    persistNow();
    res.json({ prefs: p });
  }
  playerRouter.get('/box-cam/prefs', (req, res) => res.json({ prefs: prefsFor(req.player.id) }));
  playerRouter.patch('/box-cam/prefs', (req, res) => {
    if (!isAdult(req.player)) return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Your parent/guardian manages Box Cam privacy settings.' });
    applyPrefs(res, req.player, req.body ?? {}, { kind: 'player', id: req.player.id });
  });
  guardianRouter.patch('/children/:id/box-cam/prefs', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    applyPrefs(res, child, req.body ?? {}, { kind: 'guardian', id: req.guardian.id });
  });

  // -------------------------------------------------------------- disputes
  const disputeWindows = new Map();
  function fileDispute(res, player, sessionId, reason, by) {
    const now = Date.now();
    const w = disputeWindows.get(player.id);
    if (w && w.resetAt > now && w.count >= 5) return res.status(429).json({ error: 'RATE_LIMITED' });
    disputeWindows.set(player.id, w && w.resetAt > now ? { count: w.count + 1, resetAt: w.resetAt } : { count: 1, resetAt: now + 86_400_000 });
    const s = db.boxSessions.find((x) => x.id === sessionId && x.playerId === player.id && TERMINAL_STATES.has(x.status));
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    const text = String(reason ?? '').trim();
    if (!text) return res.status(400).json({ error: 'REASON_REQUIRED' });
    if (!moderateOrRefuse(res, text, { kind: 'box_dispute', playerId: player.id })) return;
    const d = {
      id: nextId('boxd'), sessionId: s.id, playerId: player.id, by,
      reason: text.slice(0, 500), status: 'open', resolution: null, createdAt: now,
    };
    db.boxCamDisputes.push(d);
    persistNow();
    res.status(201).json({ dispute: d, note: 'Trust & Safety reviews Box Cam disputes. Verified results are never edited by hand — they can be invalidated or restored, not invented.' });
  }
  playerRouter.post('/box-cam/sessions/:id/dispute', (req, res) => fileDispute(res, req.player, req.params.id, req.body?.reason, { kind: 'player', id: req.player.id, name: req.player.name }));
  guardianRouter.post('/children/:id/box-cam/sessions/:sid/dispute', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    fileDispute(res, child, req.params.sid, req.body?.reason, { kind: 'guardian', id: req.guardian.id, name: req.guardian.name });
  });

  // ------------------------------------------------------------------ T&S
  adminRouter.get('/box-cam/disputes', (req, res) => {
    const items = db.boxCamDisputes
      .filter((d) => req.query.all === '1' || d.status === 'open')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((d) => ({ ...d, session: ctx.boxSessionView(db.boxSessions.find((s) => s.id === d.sessionId) ?? {}, { includeIntegrity: true }) }));
    res.json({ items });
  });
  adminRouter.post('/box-cam/disputes/:id/resolve', (req, res) => {
    const d = db.boxCamDisputes.find((x) => x.id === req.params.id);
    if (!d) return res.status(404).json({ error: 'DISPUTE_NOT_FOUND' });
    if (d.status !== 'open') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    const { outcome, reason } = req.body ?? {};
    // T&S can invalidate or let a result stand — it can never fabricate
    // verified durations, rep counts or completion.
    if (!['stands', 'invalidated', 'provider_bug'].includes(outcome)) return res.status(400).json({ error: 'OUTCOME_REQUIRED', allowed: ['stands', 'invalidated', 'provider_bug'] });
    if (!String(reason ?? '').trim()) return res.status(400).json({ error: 'REASON_REQUIRED' });
    const s = db.boxSessions.find((x) => x.id === d.sessionId);
    if ((outcome === 'invalidated' || outcome === 'provider_bug') && s) {
      s.previousVerificationState = s.verificationState;
      s.verificationState = 'invalidated';
      s.status = 'invalidated';
      s.invalidatedAt = Date.now();
      ledgerAppend({ type: 'box_result_invalidated', playerId: s.playerId, orgId: null, detail: { sessionId: s.id, disputeId: d.id, outcome } });
    }
    d.status = 'resolved';
    d.resolution = { outcome, reason: String(reason).slice(0, 400), at: Date.now() };
    const target = d.by.kind === 'guardian' ? { kind: 'guardian', id: d.by.id } : { kind: 'player', id: d.playerId };
    notify(target, 'box_cam', `Trust & Safety resolved your Box Cam dispute: ${outcome === 'stands' ? 'the result stands' : 'the result was invalidated'}.`, d.id);
    persistNow();
    res.json({ dispute: d });
  });
  adminRouter.post('/box-cam/sessions/:id/restore', (req, res) => {
    const s = db.boxSessions.find((x) => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (s.verificationState !== 'invalidated' || !s.previousVerificationState) return res.status(409).json({ error: 'NOT_INVALIDATED' });
    if (!String(req.body?.reason ?? '').trim()) return res.status(400).json({ error: 'REASON_REQUIRED' });
    s.verificationState = s.previousVerificationState;
    s.status = s.previousVerificationState;
    s.previousVerificationState = null;
    s.invalidatedAt = null;
    ledgerAppend({ type: 'box_result_restored', playerId: s.playerId, orgId: null, detail: { sessionId: s.id, reason: String(req.body.reason).slice(0, 300) } });
    persistNow();
    res.json({ session: ctx.boxSessionView(s) });
  });

  // -------------------------------------------------- seed ScoutBox challenges
  if (!db.boxChallenges.some((c) => c.publisher.kind === 'scoutbox')) {
    const now = Date.now();
    db.boxChallenges.push(
      {
        id: nextId('boxc'), title: 'The 1,000 Touch Box Challenge',
        publisher: { kind: 'scoutbox' }, drillId: 'box-touches', metric: 'reps', targetTotal: 1000,
        startsAt: now, endsAt: now + 30 * 86_400_000, adultOnly: false, cap: null, status: 'active', createdAt: now,
      },
      {
        id: nextId('boxc'), title: '7-Day First Touch Box Challenge',
        publisher: { kind: 'scoutbox' }, drillId: 'box-control', metric: 'active_minutes', targetTotal: 60,
        startsAt: now, endsAt: now + 7 * 86_400_000, adultOnly: false, cap: null, status: 'active', createdAt: now,
      },
    );
  }

  return { assignmentView, challengeView, developmentPlan };
}
