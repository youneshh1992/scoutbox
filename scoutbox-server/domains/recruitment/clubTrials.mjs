// A club's own trials: the calendar export and the mandatory performance report.
import { computeTrustScore, validateTrialReport, TRIAL_REPORT_FIELDS, parseTrialDate } from '../../domain.mjs';
import { readInstant } from '../../temporal.mjs';
import { icsLocal, icsText } from './lifecycle/trial.mjs';

export function registerClubTrials({
  orgRouter,
  recruitment,
  findPlayer,
  isBlocked,
  moderateOrRefuse,
  unit,
  nextId,
  ledgerAppend,
  notify,
  broadcast,
}) {
  const ownTrial = (req, id) => {
    const t = recruitment.trials.byId(id);
    return t && t.orgId === req.org.id ? t : null;
  };

  orgRouter.get('/trials/:id/ics', (req, res) => {
    const t = ownTrial(req, req.params.id);
    if (!t) return res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
    const deadline = Number.isFinite(t.reportDueAt)
      ? ` Mandatory performance report due ${new Date(t.reportDueAt).toISOString().slice(0, 10)}.`
      : '';
    // A scheduled trial exports each session of the current revision as its own timed event in the organiser's zone
    // (`DTSTART;TZID=`). A cancelled trial exports its sessions as CANCELLED rather than silently vanishing from a
    // calendar that already holds them; an unconfirmed revision is TENTATIVE.
    if (t.schedule && Array.isArray(t.schedule.sessions) && t.schedule.sessions.length) {
      const tz = t.schedule.timezone;
      const cancelled = t.completion?.state === 'cancelled';
      const status = cancelled ? 'CANCELLED' : t.schedule.confirmedAt ? 'CONFIRMED' : 'TENTATIVE';
      // DTSTAMP from the first readable clock, so a row with none never throws inside toISOString.
      const stampMs =
        readInstant(t.schedule.confirmedAt) ??
        readInstant(t.schedule.proposedAt) ??
        readInstant(t.acceptedAt) ??
        Date.now();
      const stamp = new Date(stampMs)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
      const events = t.schedule.sessions
        .slice()
        .sort((a, b) => a.startsAt - b.startsAt || String(a.id).localeCompare(String(b.id)))
        .flatMap((s) => {
          const where = s.venue
            ? [s.venue.name, s.venue.address, s.venue.town].filter(Boolean).join(', ')
            : (t.venue ?? null);
          return [
            'BEGIN:VEVENT',
            `UID:${t.id}-${s.id}@scoutbox`,
            `DTSTAMP:${stamp}`,
            `DTSTART;TZID=${tz}:${icsLocal(s.startsAt, tz)}`,
            `DTEND;TZID=${tz}:${icsLocal(s.endsAt, tz)}`,
            `SEQUENCE:${Number(t.schedule.revision) || 1}`,
            `STATUS:${status}`,
            `SUMMARY:${icsText(`ScoutBox trial (${s.kind ?? 'session'}) — ${t.playerName ?? 'removed player'}${cancelled ? ' — CANCELLED' : ''}`)}`,
            `DESCRIPTION:${icsText(`${s.instructions || t.notes || 'Trial session'}.${deadline}`)}`,
            where ? `LOCATION:${icsText(where)}` : null,
            'END:VEVENT',
          ].filter(Boolean);
        });
      const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ScoutBox//Trials//EN', ...events, 'END:VCALENDAR'].join(
        '\r\n',
      );
      return res.set('Content-Type', 'text/calendar').send(ics);
    }
    // Without a schedule the export is the accepted day as an all-day event, with nothing invented about a time or a
    // venue. A stored date that is not a calendar day is refused as what it is, never a 500 or a fabricated day.
    const day = parseTrialDate(t.proposedDate);
    if (!day.ok)
      return res.status(422).json({
        error: 'TRIAL_DATE_INVALID',
        message:
          'This trial was recorded with a date that is not a calendar day; postpone it to a valid day to export it.',
        expected: day.expected,
      });
    const startAt = day.t ?? (Number.isFinite(t.acceptedAt) ? t.acceptedAt : null);
    if (startAt === null)
      return res.status(422).json({ error: 'TRIAL_DATE_INVALID', message: 'This trial has no usable date to export.' });
    const start = new Date(startAt).toISOString().slice(0, 10).replace(/-/g, '');
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ScoutBox//Trials//EN',
      'BEGIN:VEVENT',
      `UID:${t.id}@scoutbox`,
      `DTSTART;VALUE=DATE:${start}`,
      `SUMMARY:${icsText(`ScoutBox trial — ${t.playerName ?? 'removed player'}`)}`,
      `DESCRIPTION:${icsText(t.notes || 'Assessment trial')}.${deadline}`,
      t.venue ? `LOCATION:${icsText(t.venue)}` : null,
      'END:VEVENT',
      'END:VCALENDAR',
    ]
      .filter(Boolean)
      .join('\r\n');
    res.set('Content-Type', 'text/calendar').send(ics);
  });

  // Trial Performance Reports: mandatory, complete or rejected.
  orgRouter.post('/trials/:trialId/report', (req, res) => {
    const trial = ownTrial(req, req.params.trialId);
    if (!trial) return res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
    if (trial.status === 'reported') return res.status(409).json({ error: 'ALREADY_REPORTED' });
    // The subject removed their account: there is no profile for the report to land on and nobody to deliver
    // feedback to. The tombstone keeps what happened, and nothing new is written about a person who left.
    if (trial.subjectRemovedAt || !findPlayer(trial.playerId)) {
      return res.status(409).json({
        error: 'TRIAL_SUBJECT_REMOVED',
        message:
          'This player removed their ScoutBox account. The trial stays on record; no report can be filed for it.',
      });
    }

    const check = validateTrialReport(req.body);
    if (!check.ok) {
      return res.status(400).json({
        error: 'REPORT_INCOMPLETE',
        message: 'Trial performance reports are mandatory and must be complete. Partial reports are rejected.',
        requiredFields: TRIAL_REPORT_FIELDS,
        missing: check.missing,
        invalid: check.invalid,
      });
    }

    // Optional development feedback — one strength, one focus area — delivered even when the trial doesn't lead
    // anywhere: the player always gets something back.
    const { strengthNote, focusNote } = req.body || {};
    if (strengthNote && !moderateOrRefuse(res, strengthNote, { kind: 'trial_feedback', orgId: req.org.id })) return;
    if (focusNote && !moderateOrRefuse(res, focusNote, { kind: 'trial_feedback', orgId: req.org.id })) return;

    const report = {
      id: nextId('rep'),
      trialId: trial.id,
      playerId: trial.playerId,
      orgId: req.org.id,
      orgName: req.org.name,
      userId: req.orgUser.id,
      scoutName: req.orgUser.name,
      filedAt: Date.now(),
      ...Object.fromEntries(TRIAL_REPORT_FIELDS.map((f) => [f, req.body[f]])),
      notes: req.body.notes || '',
      strengthNote: strengthNote || null,
      focusNote: focusNote || null,
    };
    // The player's `trialReports` is derived from the trials, in filing order; no copy is written onto the player.
    const p = findPlayer(trial.playerId);
    unit(() => {
      recruitment.trials.fileReport(trial.id, { report });
      ledgerAppend({
        type: 'trial_report',
        playerId: p.id,
        orgId: req.org.id,
        orgName: req.org.name,
        userId: req.orgUser.id,
        scoutName: req.orgUser.name,
      });
    });
    // The report closes the club's obligation even while the family has blocked the club, but the block stands: no
    // notification reaches the player or guardian. The report is still on the profile when they look.
    if (!isBlocked(p.id, req.org.id)) {
      notify(
        { kind: 'player', id: p.id },
        'trial_report',
        `${req.org.name} filed your trial report${report.strengthNote ? ' — with development feedback' : ''}. It's on your profile.`,
        report.id,
      );
      if (p.guardianId)
        notify(
          { kind: 'guardian', id: p.guardianId },
          'trial_report',
          `${req.org.name} filed the trial report for ${p.name}.`,
          report.id,
        );
    }
    broadcast('players', { playerId: p.id });
    res.status(201).json({ ok: true, report, playerTrustScore: computeTrustScore(p) });
  });
}
