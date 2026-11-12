// Scheduled behaviour is a persisted record examined by an idempotent sweep (at boot and every 60 s). The marker that
// a reminder went out lives in the database, not in a timer, so restarts lose and re-send nothing.

import { isAdult, visibleToOrg } from '../../domain.mjs';
import { deriveWorkflowState } from '../recruitment/public.mjs';
import { readPage, sendPageError } from '../platform/paging.mjs';
import { operationsInput } from './schemas.mjs';
import { asSweep } from '../../writeRules.mjs';

const MILESTONES = { '3m': 91, '6m': 182, '12m': 365 };

export function registerOperations(ctx) {
  const {
    byId,
    nextId,
    notify,
    ledgerAppend,
    broadcast,
    findPlayer,
    orgRouter,
    playerRouter,
    guardianRouter,
    adminRouter,
    guardianOwnsChild,
    orgCanSee,
    moderateOrRefuse,
    storage,
    sessionFor,
    isBlocked,
    DATA_DIR,
    players,
    users,
    unit,
    signingsFollowUps,
    recruitment,
    scoutingReads,
    opportunitiesCampaigns,
  } = ctx;
  if (!recruitment?.trials)
    throw new TypeError('registerOperations needs the recruitment repository from the data layer');
  const trials = recruitment.trials;
  if (
    typeof signingsFollowUps?.followUps?.schedule !== 'function' ||
    typeof signingsFollowUps?.outcomeReports?.file !== 'function'
  )
    throw new TypeError('registerOperations needs the signings/follow-ups repository from the data layer');
  const fu = signingsFollowUps.followUps;
  const outcomes = signingsFollowUps.outcomeReports;
  const usersOf = (orgId) => users.forOrg(orgId, { active: true });

  // ========================================================= outcomes
  function scheduleFollowUps(signing) {
    let added = 0;
    for (const [milestone, days] of Object.entries(MILESTONES)) {
      if (fu.forSigning(signing.id).some((f) => f.milestone === milestone)) continue;
      fu.schedule({
        id: nextId('fup'),
        signingId: signing.id,
        playerId: signing.playerId,
        orgId: signing.orgId,
        milestone,
        dueAt: (signing.signedAt ?? signing.ts ?? Date.now()) + days * 86_400_000,
        status: 'scheduled',
        notifiedAt: null,
        createdAt: Date.now(),
      });
      added++;
    }
    return added;
  }

  /** Lookups for one response: a list names the same player and club on every row, so each is read once. */
  const viewLookups = () => {
    const players = new Map();
    const orgs = new Map();
    const once = (cache, read) => (id) => {
      if (!cache.has(id)) cache.set(id, read(id));
      return cache.get(id);
    };
    return { player: once(players, findPlayer), org: once(orgs, byId.org) };
  };
  const followUpViews = (list) => {
    const look = viewLookups();
    return list.map((f) => followUpView(f, look));
  };

  function followUpView(f, look = viewLookups()) {
    const report = outcomes.forFollowUp(f.id);
    const p = look.player(f.playerId);
    const org = look.org(f.orgId);
    return {
      id: f.id,
      signingId: f.signingId,
      playerId: f.playerId,
      orgId: f.orgId,
      milestone: f.milestone,
      dueAt: f.dueAt,
      status: f.status,
      notifiedAt: f.notifiedAt,
      createdAt: f.createdAt,
      playerName: p?.name ?? 'departed player',
      orgName: org?.name ?? f.orgId,
      report,
      outcomeState: !report
        ? f.status === 'due'
          ? 'unknown_pending'
          : 'not_due'
        : report.confirmations.some((c) => !c.agree)
          ? 'disputed'
          : report.confirmations.some((c) => c.agree)
            ? 'confirmed'
            : 'reported',
    };
  }

  orgRouter.get('/followups', (req, res) => {
    const query = operationsInput(res, 'page', req.query, 'query');
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number', 'string']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const { items, nextCursor } = fu.pageForOrg(req.org.id, page);
    res.json({ items: followUpViews(items), nextCursor });
  });

  orgRouter.post('/followups/:id/report', (req, res) => {
    const found = fu.byId(req.params.id);
    const f = found && found.orgId === req.org.id ? found : null;
    if (!f) return res.status(404).json({ error: 'FOLLOWUP_NOT_FOUND' });
    if (outcomes.forFollowUp(f.id)) return res.status(409).json({ error: 'ALREADY_REPORTED' });
    const body = operationsInput(res, 'outcomeReport', req.body);
    if (!body) return;
    const { registrationStatus, matchesPlayed, progression, endReason, note } = body;
    if (note && !moderateOrRefuse(res, note, { kind: 'outcome_report', playerId: f.playerId, orgId: req.org.id }))
      return;
    const report = {
      id: nextId('out'),
      followUpId: f.id,
      signingId: f.signingId,
      playerId: f.playerId,
      orgId: f.orgId,
      by: { kind: 'org', id: req.orgUser.id, name: req.orgUser.name },
      registrationStatus,
      matchesPlayed: matchesPlayed ?? null, // evidence-based where it exists, null otherwise
      progression: progression || null,
      endReason: endReason || null,
      note: note || null,
      status: 'reported',
      confirmations: [],
      at: Date.now(),
    };
    const p = findPlayer(f.playerId);
    const text = `📊 ${req.org.name} filed the ${f.milestone} follow-up on the signing — please confirm or dispute it.`;
    let done;
    try {
      done = unit(() => {
        outcomes.file(report);
        const fresh = fu.patch(f.id, { status: 'complete' });
        if (p && !isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'outcome', text, f.id);
        else if (p) notify({ kind: 'player', id: p.id }, 'outcome', text, f.id);
        return fresh;
      });
    } catch (e) {
      console.error(`OUTCOME report_rolled_back ${f.id}: ${e?.message ?? e}`);
      return res
        .status(500)
        .json({ error: 'OUTCOME_STATE_UNKNOWN', message: 'The report could not be filed; nothing was recorded.' });
    }
    res.status(201).json({ followUp: followUpView(done) });
  });

  function respondOutcome(req, res, playerIds, actor) {
    const found = fu.byId(req.params.id);
    const f = found && playerIds.includes(found.playerId) ? found : null;
    const report = f && outcomes.forFollowUp(f.id);
    if (!report) return res.status(404).json({ error: 'REPORT_NOT_FOUND' });
    if (report.confirmations.some((c) => c.by.id === actor.id))
      return res.status(409).json({ error: 'ALREADY_RESPONDED' });
    const body = operationsInput(res, 'outcomeAnswer', req.body);
    if (!body) return;
    const { agree, note, experienceRating } = body;
    if (note && !moderateOrRefuse(res, note, { kind: 'outcome_response', playerId: f.playerId })) return;
    try {
      unit(() =>
        outcomes.addConfirmation(
          report.id,
          { by: actor, agree, note: note || null, experienceRating: experienceRating ?? null, at: Date.now() },
          { status: agree ? 'confirmed' : 'disputed' },
        ),
      );
    } catch (e) {
      console.error(`OUTCOME response_rolled_back ${report.id}: ${e?.message ?? e}`);
      return res
        .status(500)
        .json({ error: 'OUTCOME_STATE_UNKNOWN', message: 'The answer could not be recorded; nothing was recorded.' });
    }
    res.json({ followUp: followUpView(f) });
  }

  playerRouter.get('/followups', (req, res) => {
    res.json(followUpViews(fu.forPlayer(req.player.id)));
  });
  playerRouter.post('/followups/:id/respond', (req, res) => {
    if (req.playerIsMinor)
      return res
        .status(403)
        .json({ error: 'GUARDIAN_MANAGED', message: 'Your parent/guardian confirms placement outcomes.' });
    respondOutcome(req, res, [req.player.id], { kind: 'player', id: req.player.id, name: req.player.name });
  });
  guardianRouter.get('/followups', (req, res) => {
    res.json(followUpViews(fu.forPlayers(req.guardian.childIds)));
  });
  guardianRouter.post('/followups/:id/respond', (req, res) =>
    respondOutcome(req, res, req.guardian.childIds, { kind: 'guardian', id: req.guardian.id, name: req.guardian.name }),
  );

  // Defined denominators, missing data named, and groups under 3 records suppressed so no individual answer is
  // inferable.
  adminRouter.get('/outcomes', (_req, res) => {
    const rows = [];
    const totals = signingsFollowUps.outcomeTotalsByOrg(); // counted in SQL, one row per organisation with a signing
    for (const org of ctx.orgs.list()) {
      const t = totals.get(org.id);
      if (!t) continue;
      if (t.signings < 3) {
        rows.push({
          orgId: org.id,
          orgName: org.name,
          suppressed: true,
          note: 'Fewer than 3 signings — details suppressed to protect individual responses.',
        });
        continue;
      }
      rows.push({
        orgId: org.id,
        orgName: org.name,
        suppressed: false,
        signings: t.signings,
        followUpsDue: t.followUpsDue,
        reported: t.reported,
        confirmed: t.confirmed,
        disputed: t.disputed,
        unknown: t.followUpsDue - t.reported,
        retained: t.retained,
        denominator: `retention counts confirmed+reported registrations over ${t.followUpsDue} due follow-ups (${t.followUpsDue - t.reported} unknown)`,
      });
    }
    res.json({ rows, note: 'Missing data is counted as unknown, never as failure or success.' });
  });

  // ========================================================= captions
  // Serving captions uses the same live entitlement rule as the media bytes.
  playerRouter.post('/media/:id/captions', (req, res) => {
    const m = req.player.media.find((x) => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
    const body = operationsInput(res, 'captions', req.body);
    if (!body) return;
    const vtt = body.vtt ?? '';
    if (!vtt.trim().startsWith('WEBVTT'))
      return res
        .status(400)
        .json({ error: 'VTT_REQUIRED', message: 'Captions are a WebVTT track (starts with "WEBVTT").' });
    if (vtt.length > 200_000) return res.status(413).json({ error: 'CAPTIONS_TOO_LARGE' });
    players.patchItem(req.player.id, 'media', { id: m.id }, { captions: vtt });
    broadcast('players', { playerId: req.player.id });
    res.json({ media: { id: m.id, captions: true } });
  });

  ctx.app.get('/media/:id/captions', (req, res) => {
    const owner = byId.mediaOwner(req.params.id);
    const m = owner?.media.find((x) => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
    const session = sessionFor(req);
    const entitled =
      session &&
      ((session.kind === 'player' && owner.id === session.refId) ||
        (session.kind === 'guardian' && owner.guardianId === session.refId) ||
        (session.kind === 'org' &&
          (() => {
            const org = byId.org(session.refId);
            return org && !org.suspended && visibleToOrg(owner, org) && !isBlocked(owner.id, org.id);
          })()));
    if (!entitled) return res.status(401).json({ error: 'MEDIA_AUTH_REQUIRED' });
    if (!m.captions)
      return res.status(404).json({ error: 'NO_CAPTIONS', message: 'This video has no caption track yet.' });
    res.set('Content-Type', 'text/vtt').send(m.captions);
  });

  // ================================================= football context
  playerRouter.post('/football-category', (req, res) => {
    const body = operationsInput(res, 'footballCategory', req.body);
    if (!body) return;
    const c = body.category;
    players.setFootballCategory(req.player.id, c);
    res.json({ footballCategory: c });
  });

  // ================================================================ sweep
  // Runs at boot (catching anything that came due while the process was down) and every minute.
  function sweep() {
    let changed = false;
    const now = Date.now();

    // Backfill follow-ups for signings without them, then mark due.
    for (const s of signingsFollowUps.signings.missingFollowUps(Object.keys(MILESTONES).length)) {
      if (scheduleFollowUps(s) > 0) changed = true;
    }
    for (const f of fu.dueToMark(now)) {
      fu.patch(f.id, { status: 'due' });
      changed = true;
    }
    for (let f of fu.dueUnnotified()) {
      f = fu.patch(f.id, { notifiedAt: now }); // committed before anything else, so a restart cannot double-send
      const org = byId.org(f.orgId);
      const p = findPlayer(f.playerId);
      const lead = usersOf(f.orgId)[0];
      if (lead)
        notify(
          { kind: 'org_user', id: lead.id },
          'outcome',
          `⏰ ${f.milestone} follow-up due for ${p?.name ?? 'a signed player'} — file the outcome report.`,
          f.id,
        );
      if (p && !isAdult(p) && p.guardianId)
        notify(
          { kind: 'guardian', id: p.guardianId },
          'outcome',
          `How is ${p.name} getting on at ${org?.name}? A ${f.milestone} check-in is due — you can confirm or dispute the club's report.`,
          f.id,
        );
      else if (p)
        notify(
          { kind: 'player', id: p.id },
          'outcome',
          `How is it going at ${org?.name}? Your ${f.milestone} check-in is due.`,
          f.id,
        );
      changed = true;
      changed = true;
    }

    // Outstanding application outcomes nag once after 7 days; the marker commits with the notification.
    for (const a of scoutingReads.applications.remindersDue(now - 7 * 86_400_000)) {
      unit(() => {
        opportunitiesCampaigns.applications.update(a.id, (d) => {
          d.remindedAt = now;
        });
        const lead = usersOf(a.orgId)[0];
        if (lead)
          notify(
            { kind: 'org_user', id: lead.id },
            'application',
            `⏳ ${a.playerName ?? 'A player'}'s application has waited a week — every applicant gets an answer.`,
            a.id,
          );
      });
      changed = true;
    }

    // Overdue trial feedback escalates once, to the club. The query already narrows to these trials; the check below
    // repeats the rule.
    for (const t of trials.reportOverdue(now)) {
      // A null deadline is unknown, not now; a tombstoned trial has nobody to file for.
      if (
        Number.isFinite(t.reportDueAt) &&
        t.reportDueAt < now &&
        !t.report &&
        !t.feedbackEscalatedAt &&
        !t.subjectRemovedAt
      ) {
        trials.escalateFeedback(t.id, { at: now });
        const lead = usersOf(t.orgId)[0];
        if (lead)
          notify(
            { kind: 'org_user', id: lead.id },
            'trial_day',
            `🚨 Trial feedback for ${t.playerName} is overdue — the mandatory report blocks new trials until filed.`,
            t.id,
          );
        changed = true;
      }
    }

    // A confirmed session within 48 h reminds the recipient (the guardian for a minor) once per session per revision.
    // A trial whose last session ended a day ago without completion, and a completed trial without an assessment after
    // a week, remind the club lead once each. A blocked club sends the family nothing.
    for (const t of trials.remindersDue(now)) {
      // only the confirmed, open trials with a reminder due
      if (t.subjectRemovedAt || !t.schedule?.confirmedAt) continue;
      if (deriveWorkflowState(t) !== 'scheduled') continue;
      const marks = {}; // set by this sweep, written once below
      const p = findPlayer(t.playerId);
      const blocked = isBlocked(t.playerId, t.orgId);
      for (const s of t.schedule.sessions ?? []) {
        const key = `t48:${s.id}:${t.schedule.revision}`;
        if (t.reminders[key] || !Number.isFinite(s.startsAt)) continue;
        if (s.startsAt <= now || s.startsAt - now > 48 * 3600_000) continue;
        marks[key] = now;
        changed = true;
        if (!p || blocked) continue;
        const toGuardian = t.recipient?.type === 'guardian' || (!isAdult(p) && p.guardianId);
        if (toGuardian && p.guardianId)
          notify(
            { kind: 'guardian', id: p.guardianId },
            'trial_day',
            `⏰ ${p.name}'s trial session with ${t.orgName} is within 48 hours.`,
            t.id,
          );
        else
          notify(
            { kind: 'player', id: p.id },
            'trial_day',
            `⏰ Your trial session with ${t.orgName} is within 48 hours.`,
            t.id,
          );
      }
      const lastEnd = (t.schedule.sessions ?? []).reduce(
        (m, s) => (Number.isFinite(s.endsAt) ? Math.max(m, s.endsAt) : m),
        0,
      );
      if (lastEnd && now - lastEnd > 24 * 3600_000 && !t.reminders.completionPending) {
        marks.completionPending = now;
        const lead = usersOf(t.orgId)[0];
        if (lead)
          notify(
            { kind: 'org_user', id: lead.id },
            'trial_day',
            `The trial for ${t.playerName} has ended — record attendance and complete it.`,
            t.id,
          );
        changed = true;
      }
      if (Object.keys(marks).length) trials.markReminders(t.id, { markers: marks });
    }
    for (const t of trials.completedUnreminded(now - 7 * 86_400_000)) {
      if (t.subjectRemovedAt || t.completion?.state !== 'completed' || t.reminders?.assessmentPending) continue;
      if (!Number.isFinite(t.completion.at) || now - t.completion.at < 7 * 86_400_000) continue;
      if (ctx.scoutingReads.assessments.anyForTrial(t.id)) continue;
      trials.markReminders(t.id, { markers: { assessmentPending: now } });
      const lead = usersOf(t.orgId)[0];
      if (lead)
        notify(
          { kind: 'org_user', id: lead.id },
          'trial_day',
          `No assessment has been recorded for ${t.playerName}'s completed trial yet.`,
          t.id,
        );
      changed = true;
    }

    // Abandoned upload sessions are cleaned after 24 h.
    if (ctx.sweepUploads(now)) changed = true;
  }

  // Ordinary admin actions: they change when, never what.
  adminRouter.post('/sweep', (req, res) => {
    if (!operationsInput(res, 'none', req.body)) return;
    asSweep(sweep);
    res.json({ ok: true });
  });
  adminRouter.post('/followups/:id', (req, res) => {
    const f = fu.byId(req.params.id);
    if (!f) return res.status(404).json({ error: 'FOLLOWUP_NOT_FOUND' });
    const body = operationsInput(res, 'dueAt', req.body);
    if (!body) return;
    let fresh;
    try {
      fresh = fu.patch(f.id, { dueAt: body.dueAt });
    } catch (e) {
      console.error(`OUTCOME due_at_rolled_back ${f.id}: ${e?.message ?? e}`);
      return res.status(500).json({ error: 'OUTCOME_STATE_UNKNOWN' });
    }
    res.json({ followUp: followUpView(fresh) });
  });

  sweep(); // boot pass
  return { followUpSweep: sweep };
}
