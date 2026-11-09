// Box Training: coach assignments, the Development Plan, Box
// Challenges, disputes and Trust & Safety tooling.
//
// Assignments and challenges NEVER widen access: every org action passes
// the standing gates (visibleToOrg incl. the agency/minor wall and the
// grassroots radius, blocks, verified organisation, not suspended).
// Agencies cannot assign Box Training at all. Coaches receive session
// RESULTS, never raw home footage — no such footage exists server-side.
//
// Every record is a row of repositories/boxCam.mjs, written by an explicit operation (inside one unit of work with
// its ledger rows and notifications), read through `boxCamReads`.
import { isAdult, visibleToOrg } from '../../../domain.mjs';
import { isAbsent, parseStrictDateOnly } from '../../../temporal.mjs';
import { challengeProgress, developmentActivity, fmtMs, TERMINAL_STATES, pageNewestFirst } from './shared.mjs';
import { latestDrill, DRILLS } from './drills.mjs';
import { readPage, pageOf, sendPageError, encodeCursor } from '../../platform/paging.mjs';

const fieldInvalid = (res, field, message) => res.status(400).json({ error: 'FIELD_INVALID', field, message });
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

export function registerBoxTraining(ctx) {
  const {
    byId, playerRouter, guardianRouter, orgRouter, adminRouter, nextId,
    notify, ledgerAppend, findPlayer, isBlocked, vmetric,
    moderateOrRefuse, broadcast, boxCam, boxCamReads: reads, unit,
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

  // Org-side drill registry (same versioned catalogue players see).
  orgRouter.get('/box-cam/drills', (_req, res) => res.json({ drills: ctx.drillList() }));

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
    // The value is a positive number as sent: a numeric string is refused.
    if (!drill.targetTypes.includes(t.type) || typeof t.value !== 'number' || !Number.isFinite(t.value) || t.value <= 0) {
      return res.status(400).json({ error: 'TARGET_INVALID', allowed: drill.targetTypes });
    }
    // Refused, not coerced: a frequency is a whole number of sessions a week, a due date a real day.
    const freq = req.body?.frequencyPerWeek;
    if (!isAbsent(freq) && !isInt(freq, 1, 14)) return fieldInvalid(res, 'frequencyPerWeek', 'A frequency is a whole number of sessions a week, from 1 to 14.');
    const due = req.body?.dueDate;
    if (!isAbsent(due) && !parseStrictDateOnly(due).ok) return res.status(400).json({ error: 'DATE_INVALID', field: 'dueDate', message: 'A due date is a calendar day written YYYY-MM-DD.', expected: 'YYYY-MM-DD' });
    const instructions = req.body?.instructions;
    if (!isAbsent(instructions) && typeof instructions !== 'string') return fieldInvalid(res, 'instructions', 'Instructions are text.');
    if (instructions && !moderateOrRefuse(res, instructions, { kind: 'box_assignment', orgId: req.org.id, playerId: p.id })) return;
    let objectiveId = null;
    if (req.body?.objectiveId) {
      const found = typeof req.body.objectiveId === 'string' ? ctx.developmentReads.objectives.byId(req.body.objectiveId) : null;
      const obj = found && found.playerId === p.id && found.orgId === req.org.id ? found : null;
      if (!obj) return res.status(404).json({ error: 'OBJECTIVE_NOT_FOUND' });
      objectiveId = obj.id;
    }
    const at = Date.now();
    const a = {
      id: nextId('boxa'), playerId: p.id, orgId: req.org.id, orgName: req.org.name,
      assignedBy: { userId: req.orgUser.id, name: req.orgUser.name, role: req.orgUser.role ?? null, orgVerifiedAtAssignment: true, at },
      drillId: drill.id, drillVersion: drill.version,
      target: { type: t.type, value: t.value },
      frequencyPerWeek: isAbsent(freq) ? null : freq,
      dueDate: isAbsent(due) ? null : parseStrictDateOnly(due).value,
      instructions: instructions ? instructions.slice(0, 300) : null,
      objectiveId,
      state: 'assigned', createdAt: at, updatedAt: at,
    };
    const stored = unit(() => {
      const row = boxCam.assignments.create(a);
      ledgerAppend({ type: 'box_assignment_created', playerId: p.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name, detail: { drillId: drill.id, target: a.target } });
      if (!isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'box_cam', `${req.org.name} assigned ${p.name} Box Training: ${drill.title}.`, a.id);
      else notify({ kind: 'player', id: p.id }, 'box_cam', `${req.org.name} assigned you Box Training: ${drill.title}. Train in the Box.`, a.id);
      return row;
    });
    vmetric('box_assignment_created');
    res.status(201).json({ assignment: assignmentView(stored) });
  });

  orgRouter.get('/box-cam/assignments', (req, res) => {
    // A block or visibility change after assignment hides the player again. Bounded by one club's assignments: the
    // visibility rule is applied in code, then the page is cut.
    const mine = reads.assignments.forOrg(req.org.id, { playerId: req.query.playerId ? String(req.query.playerId) : null })
      .filter((a) => { const p = findPlayer(a.playerId); return p && orgCanSee(req.org, p); });
    const page = pageNewestFirst(req, res, mine, { readPage, pageOf, sendPageError });
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
    const a = reads.assignments.byId(req.params.id);
    if (!a || a.orgId !== req.org.id) return res.status(404).json({ error: 'ASSIGNMENT_NOT_FOUND' });
    if (a.state === 'cancelled') return res.status(409).json({ error: 'ALREADY_CANCELLED' });
    const next = unit(() => {
      const row = boxCam.assignments.update(a.id, (d) => { d.state = 'cancelled'; d.updatedAt = Date.now(); });
      ledgerAppend({ type: 'box_assignment_cancelled', playerId: a.playerId, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name, detail: { assignmentId: a.id } });
      return row;
    });
    res.json({ assignment: assignmentView(next) });
  });

  const accept = (a) => boxCam.assignments.update(a.id, (d) => { d.state = 'accepted'; d.updatedAt = Date.now(); });
  playerRouter.get('/box-cam/assignments', (req, res) => {
    res.json({ items: reads.assignments.forPlayer(req.player.id).map(assignmentView) });
  });
  playerRouter.post('/box-cam/assignments/:id/accept', (req, res) => {
    const a = reads.assignments.byId(req.params.id);
    if (!a || a.playerId !== req.player.id) return res.status(404).json({ error: 'ASSIGNMENT_NOT_FOUND' });
    if (!isAdult(req.player)) return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Your parent/guardian accepts club-assigned training.' });
    if (a.state !== 'assigned') return res.status(409).json({ error: 'NOT_ACCEPTABLE', state: a.state });
    res.json({ assignment: assignmentView(accept(a)) });
  });
  guardianRouter.get('/children/:id/box-cam/assignments', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    res.json({ items: reads.assignments.forPlayer(req.params.id).map(assignmentView) });
  });
  guardianRouter.post('/children/:id/box-cam/assignments/:aid/accept', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const a = reads.assignments.byId(req.params.aid);
    if (!a || a.playerId !== req.params.id) return res.status(404).json({ error: 'ASSIGNMENT_NOT_FOUND' });
    if (a.state !== 'assigned') return res.status(409).json({ error: 'NOT_ACCEPTABLE', state: a.state });
    res.json({ assignment: assignmentView(accept(a)) });
  });

  /** Assignment progress from a finalized session — completion only ever
   *  derives from verified values; a near miss stays "partially". Runs inside
   *  the completion's unit of work. */
  function applyAssignmentProgress(session) {
    if (!session.assignmentId) return;
    const a = reads.assignments.byId(session.assignmentId);
    if (!a || a.state === 'cancelled') return;
    if (!['verified', 'partially_verified'].includes(session.verificationState)) return;
    let next = a.state;
    if (session.targetCompleted === true) {
      const done = reads.sessions.forAssignment(a.id).filter((s) => s.targetCompleted === true && !['cancelled', 'invalidated'].includes(s.verificationState)).length;
      next = a.frequencyPerWeek && done < a.frequencyPerWeek ? 'in_progress' : 'completed';
    } else if (a.state === 'assigned' || a.state === 'accepted') {
      next = session.verifiedActiveMs > 0 ? 'partially_completed' : 'in_progress';
    }
    boxCam.assignments.update(a.id, (d) => { d.state = next; d.updatedAt = Date.now(); });
    if (session.targetCompleted === true && next === 'completed') {
      vmetric('box_assignment_completed');
      const p = findPlayer(a.playerId);
      const lead = byId.user(a.assignedBy.userId, (u) => !u.removedAt);
      if (lead && p) notify({ kind: 'org_user', id: lead.id }, 'box_cam', `${p.name} completed Box Training: ${latestDrill(a.drillId)?.title ?? a.drillId} (${session.verifiedReps != null ? `${session.verifiedReps} verified` : fmtMs(session.verifiedActiveMs)}).`, a.id);
    }
  }

  // ------------------------------------------------------------ challenges
  const challengeView = (c, entry = null, participants = null) => ({
    id: c.id, title: c.title, publisher: c.publisher,
    drillId: c.drillId, drillTitle: latestDrill(c.drillId)?.title ?? c.drillId,
    metric: c.metric, targetTotal: c.targetTotal,
    startsAt: c.startsAt, endsAt: c.endsAt,
    adultOnly: !!c.adultOnly, cap: c.cap ?? null,
    participants: participants ?? reads.entries.countFor(c.id),
    entry: entry ? { id: entry.id, status: entry.status, progress: entry.progress, joinedAt: entry.joinedAt, completedAt: entry.completedAt ?? null } : null,
    disclaimer: 'Completing a Box Challenge does not mean the club has scouted, selected or endorsed you unless explicitly stated through a separate ScoutBox recruitment workflow.',
  });

  function eligibleChallenges(player) {
    return reads.challenges.open(Date.now()).filter((c) => {
      if (c.adultOnly && !isAdult(player)) return false;
      if (c.publisher.kind === 'org') {
        const org = byId.org(c.publisher.orgId);
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
    // A total is a whole number of reps or minutes: a numeric string is refused.
    if (!isInt(targetTotal, 1, 100_000)) return res.status(400).json({ error: 'TARGET_INVALID' });
    // Refused, not clamped or dropped.
    if (!isAbsent(days) && !isInt(days, 1, 60)) return fieldInvalid(res, 'days', 'A challenge runs for a whole number of days, from 1 to 60.');
    if (!isAbsent(cap) && !isInt(cap, 1, 1_000_000)) return fieldInvalid(res, 'cap', 'A cap is a whole number of participants, at least 1.');
    if (!isAbsent(adultOnly) && typeof adultOnly !== 'boolean') return fieldInvalid(res, 'adultOnly', 'adultOnly is true or false.');
    if (!isAbsent(title) && typeof title !== 'string') return fieldInvalid(res, 'title', 'A title is text.');
    if (!moderateOrRefuse(res, String(title ?? ''), { kind: 'box_challenge', orgId: req.org.id })) return;
    const at = Date.now();
    const c = {
      id: nextId('boxc'), title: (title ?? '').trim().slice(0, 120) || `${drill.title} Box Challenge`,
      publisher: { kind: 'org', orgId: req.org.id, orgName: req.org.name, byName: req.orgUser.name },
      drillId: drill.id, metric, targetTotal,
      startsAt: at, endsAt: at + (isAbsent(days) ? 14 : days) * 86_400_000,
      adultOnly: adultOnly === true, cap: isAbsent(cap) ? null : cap,
      status: 'active', createdAt: at,
    };
    const stored = unit(() => {
      const row = boxCam.challenges.create(c);
      ledgerAppend({ type: 'box_challenge_published', playerId: null, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name, detail: { challengeId: c.id, drillId: c.drillId } });
      return row;
    });
    res.status(201).json({ challenge: challengeView(stored) });
  });

  orgRouter.get('/box-cam/challenges', (req, res) => {
    const page = pageNewestFirst(req, res, reads.challenges.forOrg(req.org.id), { readPage, pageOf, sendPageError });
    if (!page) return;
    const counts = reads.challenges.participants(page.items.map((c) => c.id));
    res.json({ items: page.items.map((c) => challengeView(c, null, counts.get(c.id))), nextCursor: page.nextCursor });
  });

  playerRouter.get('/box-cam/challenges', (req, res) => {
    const entries = reads.entries.forPlayer(req.player.id);
    const list = eligibleChallenges(req.player);
    const counts = reads.challenges.participants(list.map((c) => c.id));
    res.json({ items: list.map((c) => challengeView(c, entries.find((e) => e.challengeId === c.id) ?? null, counts.get(c.id))) });
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
    const entry = boxCam.entries.create({ id: nextId('boxe'), challengeId: c.id, playerId: player.id, status: 'active', progress: 0, joinedAt: Date.now(), joinedBy: by, completedAt: null });
    vmetric('box_challenge_started');
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
   *  never count. Runs inside the completion's unit of work. */
  function applyChallengeProgress(session, player) {
    const entries = reads.entries.forPlayer(session.playerId).filter((e) => e.status === 'active');
    if (!entries.length) return;
    const sessions = reads.sessions.finishedForPlayer(session.playerId);
    for (const entry of entries) {
      const c = reads.challenges.byId(entry.challengeId);
      if (!c || c.drillId !== session.drillId) continue;
      const prog = challengeProgress(c, sessions);
      const completes = prog.completed;
      boxCam.entries.update(entry.id, (d) => {
        d.progress = prog.total;
        if (completes) { d.status = 'completed'; d.completedAt = Date.now(); }
      });
      if (completes) {
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
    const objectives = ctx.developmentReads.objectives.forPlayer(player.id);
    const assignments = reads.assignments.forPlayer(player.id).filter((a) => a.state !== 'cancelled');
    const sessions = reads.sessions.finishedForPlayer(player.id).filter(standing);
    return {
      objectives: objectives.map((o) => ({
        id: o.id, orgId: o.orgId, orgName: byId.org(o.orgId)?.name ?? null,
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
  const prefsView = (p) => ({ playerId: p.playerId, shareDevelopmentActivity: p.shareDevelopmentActivity, retainClips: p.retainClips, updatedAt: p.updatedAt, updatedBy: p.updatedBy });
  function applyPrefs(res, player, body, by) {
    const current = prefsFor(player.id);
    if (body.shareDevelopmentActivity !== undefined && !['private', 'recruitment'].includes(body.shareDevelopmentActivity)) return res.status(400).json({ error: 'SHARE_INVALID', allowed: ['private', 'recruitment'] });
    // A boolean as sent: anything else is refused, not read as truthy.
    if (body.retainClips !== undefined && typeof body.retainClips !== 'boolean') return fieldInvalid(res, 'retainClips', 'retainClips is true or false.');
    const next = {
      playerId: player.id,
      shareDevelopmentActivity: body.shareDevelopmentActivity ?? current.shareDevelopmentActivity,
      retainClips: body.retainClips ?? current.retainClips,
      updatedAt: Date.now(), updatedBy: { kind: by.kind, id: by.id },
    };
    const saved = unit(() => {
      const row = boxCam.prefs.save(next);
      ledgerAppend({ type: 'box_prefs_changed', playerId: player.id, orgId: null, detail: { by: by.kind, share: row.shareDevelopmentActivity, retainClips: row.retainClips } });
      return row;
    });
    res.json({ prefs: prefsView(saved) });
  }
  playerRouter.get('/box-cam/prefs', (req, res) => res.json({ prefs: prefsView(prefsFor(req.player.id)) }));
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
  const disputeView = (d) => ({ id: d.id, sessionId: d.sessionId, playerId: d.playerId, by: d.by, reason: d.reason, status: d.status, resolution: d.resolution, createdAt: d.createdAt });
  const disputeWindows = new Map();
  function fileDispute(res, player, sessionId, reason, by) {
    const now = Date.now();
    const w = disputeWindows.get(player.id);
    if (w && w.resetAt > now && w.count >= 5) return res.status(429).json({ error: 'RATE_LIMITED' });
    disputeWindows.set(player.id, w && w.resetAt > now ? { count: w.count + 1, resetAt: w.resetAt } : { count: 1, resetAt: now + 86_400_000 });
    const s = reads.sessions.byId(sessionId);
    if (!s || s.playerId !== player.id || !TERMINAL_STATES.has(s.status)) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    const text = String(reason ?? '').trim();
    if (!text) return res.status(400).json({ error: 'REASON_REQUIRED' });
    if (!moderateOrRefuse(res, text, { kind: 'box_dispute', playerId: player.id })) return;
    const d = boxCam.disputes.create({
      id: nextId('boxd'), sessionId: s.id, playerId: player.id, by,
      reason: text.slice(0, 500), status: 'open', resolution: null, createdAt: now,
    });
    res.status(201).json({ dispute: disputeView(d), note: 'Trust & Safety reviews Box Cam disputes. Verified results are never edited by hand — they can be invalidated or restored, not invented.' });
  }
  playerRouter.post('/box-cam/sessions/:id/dispute', (req, res) => fileDispute(res, req.player, req.params.id, req.body?.reason, { kind: 'player', id: req.player.id, name: req.player.name }));
  guardianRouter.post('/children/:id/box-cam/sessions/:sid/dispute', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    fileDispute(res, child, req.params.sid, req.body?.reason, { kind: 'guardian', id: req.guardian.id, name: req.guardian.name });
  });

  // ------------------------------------------------------------------ T&S
  // The queue grows with the platform: one page, oldest first.
  adminRouter.get('/box-cam/disputes', (req, res) => {
    let page;
    try { page = readPage(req.query, ['number', 'string']); } catch (e) { return sendPageError(res, e); }
    const rows = reads.disputes.queue({ all: req.query.all === '1', after: page.after, limit: page.limit + 1 });
    const items = rows.slice(0, page.limit);
    const sessions = new Map(reads.sessions.byIds(items.map((d) => d.sessionId)).map((s) => [s.id, s]));
    res.json({
      items: items.map((d) => ({ ...disputeView(d), session: ctx.boxSessionView(sessions.get(d.sessionId) ?? {}, { includeIntegrity: true }) })),
      nextCursor: rows.length > page.limit ? encodeCursor([items[items.length - 1].createdAt, items[items.length - 1].id]) : null,
    });
  });
  adminRouter.post('/box-cam/disputes/:id/resolve', (req, res) => {
    const d = reads.disputes.byId(req.params.id);
    if (!d) return res.status(404).json({ error: 'DISPUTE_NOT_FOUND' });
    if (d.status !== 'open') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    const { outcome, reason } = req.body ?? {};
    // T&S can invalidate or let a result stand — it can never fabricate
    // verified durations, rep counts or completion.
    if (!['stands', 'invalidated', 'provider_bug'].includes(outcome)) return res.status(400).json({ error: 'OUTCOME_REQUIRED', allowed: ['stands', 'invalidated', 'provider_bug'] });
    if (!String(reason ?? '').trim()) return res.status(400).json({ error: 'REASON_REQUIRED' });
    const s = reads.sessions.byId(d.sessionId);
    const resolved = unit(() => {
      // A session with no result (it expired before it started) or one already invalidated has nothing to invalidate:
      // the dispute is resolved and the session left as it is.
      if ((outcome === 'invalidated' || outcome === 'provider_bug') && s && s.verificationState && s.verificationState !== 'invalidated') {
        const at = Date.now();
        boxCam.sessions.update(s.id, (x) => {
          x.previousVerificationState = x.verificationState;
          x.verificationState = 'invalidated';
          x.status = 'invalidated';
          x.invalidatedAt = at;
          // An append-only integrity history on the session itself, so a
          // later restore never erases the fact or the moment of invalidation.
          x.integrityEvents.push({ type: 'invalidated', at, disputeId: d.id, outcome });
        });
        ledgerAppend({ type: 'box_result_invalidated', playerId: s.playerId, orgId: null, detail: { sessionId: s.id, disputeId: d.id, outcome } });
      }
      const row = boxCam.disputes.update(d.id, (x) => { x.status = 'resolved'; x.resolution = { outcome, reason: String(reason).trim().slice(0, 400), at: Date.now() }; });
      const target = d.by.kind === 'guardian' ? { kind: 'guardian', id: d.by.id } : { kind: 'player', id: d.playerId };
      notify(target, 'box_cam', `Trust & Safety resolved your Box Cam dispute: ${outcome === 'stands' ? 'the result stands' : 'the result was invalidated'}.`, d.id);
      return row;
    });
    res.json({ dispute: disputeView(resolved) });
  });
  adminRouter.post('/box-cam/sessions/:id/restore', (req, res) => {
    const s = reads.sessions.byId(req.params.id);
    if (!s) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    if (s.verificationState !== 'invalidated' || !s.previousVerificationState) return res.status(409).json({ error: 'NOT_INVALIDATED' });
    if (!String(req.body?.reason ?? '').trim()) return res.status(400).json({ error: 'REASON_REQUIRED' });
    const restored = unit(() => {
      const row = boxCam.sessions.update(s.id, (x) => {
        x.verificationState = x.previousVerificationState;
        x.status = x.previousVerificationState;
        x.previousVerificationState = null;
        x.invalidatedAt = null;
        x.integrityEvents.push({ type: 'restored', at: Date.now(), to: x.verificationState });
      });
      ledgerAppend({ type: 'box_result_restored', playerId: s.playerId, orgId: null, detail: { sessionId: s.id, reason: String(req.body.reason).slice(0, 300) } });
      return row;
    });
    res.json({ session: ctx.boxSessionView(restored) });
  });

  // The ScoutBox challenges are a seeded catalogue: migration 0031 inserts them, never boot.

  return { assignmentView, challengeView, developmentPlan };
}
