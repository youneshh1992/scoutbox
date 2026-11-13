// The trial day of an accepted trial: its named staff and their background checks (reviewed by Trust & Safety), the
// arrival details, the day's cancellation or postponement, check-in, event consent, the family's emergency contact and
// safety pack, and the family's list of their trials. The day is part of the trial record: a postponement moves the
// trial's date and report deadline, and a check-in records the session's attendance.

import { isAdult, parseTrialDate, trialReportDueAt } from '../../domain.mjs';
import { parseDateOrInstant, isExpiredAt, isAbsent } from '../../temporal.mjs';
import { readPage, sendPageError } from '../platform/paging.mjs';
import { CURSOR_PAGE, dueDate, filled, inputOrRefuse, oneOf, text } from '../platform/schemas.mjs';
import * as v from 'valibot';
import { trialFamilyView, trialOutcomeLine } from './lifecycle/trial.mjs';

const optText = (max) => v.nullish(text(max));
// The trial-day lengths are the trial table's.
const TrialStaff = v.strictObject({
  name: optText(80),
  role: optText(60),
  check: v.nullish(v.strictObject({ kind: optText(60), ref: optText(60), expiresAt: v.optional(dueDate) })),
});
const Arrival = v.strictObject({
  time: optText(40),
  address: optText(200),
  notes: optText(300),
  collection: optText(300),
});
const TrialCancel = v.strictObject({ reason: optText(200) });
const TrialPostpone = v.strictObject({ reason: optText(200), newDate: v.nullish(v.string()) });
const POSTPONE_CODES = { fieldCodes: { newDate: 'TRIAL_DATE_INVALID' } };
const EmergencyContact = v.strictObject({ name: optText(80), phone: optText(30) });
const StaffCheckReview = v.strictObject({ status: oneOf(['reviewed', 'rejected']), expiresAt: v.optional(dueDate) });
const STAFF_CHECK_CODES = { fieldCodes: { status: 'STATUS_INVALID' } };
const StaffChecksQuery = v.strictObject({ ...CURSOR_PAGE, all: v.optional(oneOf(['0', '1'])) });

export function registerTrialDay({
  orgRouter,
  playerRouter,
  guardianRouter,
  adminRouter,
  trials,
  findPlayer,
  isBlocked,
  moderateOrRefuse,
  playerRecord,
  recordActivity,
  unit,
  nextId,
  notify,
  ledgerAppend,
}) {
  // A reference on file is not a completed check; check-in feeds the existing attendance without duplicates.

  function trialFor(req, res) {
    const found = trials.byId(req.params.id);
    const t = found && found.orgId === req.org.id ? found : null;
    if (!t) {
      res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
      return null;
    }
    // A trial whose subject removed their account can still be read (the record is the club's), but nothing new is
    // written about a person who left.
    if (t.subjectRemovedAt && req.method !== 'GET') {
      res.status(409).json({
        error: 'TRIAL_SUBJECT_REMOVED',
        message: 'This player removed their ScoutBox account. The trial stays on record; it can no longer be changed.',
      });
      return null;
    }
    return t;
  }

  orgRouter.get('/trials/:id/day', (req, res) => {
    const t = trialFor(req, res);
    if (t) res.json({ trial: trialDayView(t, 'org') });
  });

  /**
   * A reviewed check whose expiry cannot be read reads `expired` (`NaN < now` is false, so it would otherwise stay
   * reviewed for ever). A missing expiry stays "no expiry recorded".
   */
  function checkState(c, now = Date.now()) {
    if (!c) return 'missing';
    if (c.status === 'reviewed' && !isAbsent(c.expiresAt) && isExpiredAt(readCheckExpiry(c.expiresAt), now))
      return 'expired';
    return c.status;
  }
  /** A stored check expiry (a DATE_ONLY valid through that day, or an instant) as the first instant it no longer holds; NaN when unreadable. */
  function readCheckExpiry(v) {
    const p = parseDateOrInstant(v, { dayEdge: 'end' });
    return p.ok ? p.ms : NaN;
  }
  function checkExpiryOrRefuse(res, raw) {
    if (isAbsent(raw)) return null;
    const p = parseDateOrInstant(raw, { dayEdge: 'end' });
    if (!p.ok) {
      res.status(400).json({
        error: 'DATE_INVALID',
        field: 'expiresAt',
        message: `A check expiry is a calendar day (YYYY-MM-DD) or an ISO 8601 date-time with an offset (${p.why}).`,
        expected: p.expected,
      });
      return undefined;
    }
    return p.precision === 'day' ? p.value : new Date(p.ms).toISOString();
  }

  function trialDayView(t, side) {
    const day = t.day ?? {};
    const base = {
      id: t.id,
      playerId: t.playerId,
      playerName: t.playerName,
      orgId: t.orgId,
      orgName: t.orgName,
      proposedDate: t.proposedDate,
      venue: t.venue,
      reportDueAt: t.reportDueAt,
      staff: (day.staff ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        role: s.role,
        check: { kind: s.check?.kind ?? null, status: checkState(s.check), expiresAt: s.check?.expiresAt ?? null },
      })),
      arrival: day.arrival,
      collection: day.collection,
      consents: (day.consents ?? []).map((c) => ({ id: c.id, byKind: c.by.kind, scope: c.scope, at: c.at })),
      checkins: day.checkins ?? [],
      statusEvents: day.statusEvents ?? [],
      cancelled: (day.statusEvents ?? []).some((e) => e.kind === 'cancelled'),
    };
    if (side === 'org') {
      // The emergency contact is for the day's named safety staff only: it appears here and nowhere else. A block by
      // the player or guardian withholds it, evaluated on every read, so it returns if Trust & Safety lifts the block.
      // What a blocked club may still do with a trial is a policy decision, not a read-side one.
      const blocked = isBlocked(t.playerId, t.orgId);
      base.emergency = blocked ? null : (day.emergency ?? null);
      base.emergencyWithheld = blocked ? 'BLOCKED' : null;
    }
    return base;
  }

  orgRouter.post('/trials/:id/staff', (req, res) => {
    const t = trialFor(req, res);
    if (!t) return;
    const body = inputOrRefuse(res, TrialStaff, req.body ?? {});
    if (!body) return;
    const { check } = body;
    const name = filled(body.name);
    const role = filled(body.role);
    if (!name || !role) return res.status(400).json({ error: 'NAME_AND_ROLE_REQUIRED' });
    const expiresAt = check ? checkExpiryOrRefuse(res, check.expiresAt) : null;
    if (expiresAt === undefined) return;
    const s = {
      id: nextId('stf'),
      name,
      role,
      check: check
        ? {
            kind: filled(check.kind) ?? 'DBS (England & Wales)',
            ref: filled(check.ref),
            // Filing a reference does not make it reviewed: Trust & Safety moves it to 'reviewed'.
            status: 'pending',
            expiresAt,
            reviewedBy: null,
          }
        : null,
      addedBy: req.orgUser.name,
      addedAt: Date.now(),
    };
    trials.addStaff(t.id, { staff: s });
    res.status(201).json({
      staff: s,
      note: 'The check is PENDING until Trust & Safety reviews it — an uploaded reference is not a completed background check.',
    });
  });

  orgRouter.post('/trials/:id/arrival', (req, res) => {
    const t = trialFor(req, res);
    if (!t) return;
    const body = inputOrRefuse(res, Arrival, req.body ?? {});
    if (!body) return;
    const { time, address, notes, collection } = body;
    if (notes && !moderateOrRefuse(res, notes, { kind: 'trial_arrival', playerId: t.playerId, orgId: req.org.id }))
      return;
    const fresh = unit(() => {
      const set = trials.setArrival(t.id, {
        arrival: {
          time: time || null,
          address: address || null,
          notes: notes || null,
        },
        collection: collection ? { policy: collection } : null,
      });
      notifyTrialParties(
        set,
        `📍 ${set.orgName} published arrival details for the trial on ${set.proposedDate ?? 'TBC'}.`,
      );
      return set;
    });
    res.json({ trial: trialDayView(fresh, 'org') });
  });

  function notifyTrialParties(t, text) {
    const p = findPlayer(t.playerId);
    if (p && !isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'trial_day', text, t.id);
    if (p) notify({ kind: 'player', id: p.id }, 'trial_day', text, t.id);
  }

  function cancelOrPostpone(req, res, kind) {
    const t = trialFor(req, res);
    if (!t) return;
    const body = inputOrRefuse(
      res,
      kind === 'postponed' ? TrialPostpone : TrialCancel,
      req.body ?? {},
      kind === 'postponed' ? POSTPONE_CODES : {},
    );
    if (!body) return;
    const { newDate } = body;
    const reason = filled(body.reason);
    if (!reason) return res.status(400).json({ error: 'REASON_REQUIRED', field: 'reason', problem: 'required' });
    // The report deadline is re-derived from the new day by the shared derivation, never computed here.
    const moved = kind === 'postponed' ? parseTrialDate(newDate) : { ok: true, value: null };
    if (!moved.ok) return res.status(400).json({ ...moved, field: 'newDate' });
    const event = {
      kind,
      at: Date.now(),
      by: req.orgUser.name,
      reason,
      newDate: moved.value,
    };
    const fresh = unit(() => {
      const recorded = trials.recordDayStatus(
        t.id,
        kind === 'postponed' && moved.value
          ? { event, proposedDate: moved.value, reportDueAt: trialReportDueAt(moved.value, t.acceptedAt) }
          : { event },
      );
      notifyTrialParties(
        recorded,
        kind === 'cancelled'
          ? `❌ ${recorded.orgName} cancelled this trial day: ${reason}`
          : `📅 ${recorded.orgName} moved the trial to ${newDate ?? 'a new date TBC'}: ${reason}`,
      );
      return recorded;
    });
    res.json({ trial: trialDayView(fresh, 'org') });
  }
  orgRouter.post('/trials/:id/cancel', (req, res) => cancelOrPostpone(req, res, 'cancelled'));
  orgRouter.post('/trials/:id/postpone', (req, res) => cancelOrPostpone(req, res, 'postponed'));

  // Check-in needs a reviewed, unexpired check on at least one named staff member and the right consent.
  orgRouter.post('/trials/:id/checkin', (req, res) => {
    const t = trialFor(req, res);
    if (!t) return;
    if (t.day.statusEvents.some((e) => e.kind === 'cancelled'))
      return res.status(409).json({ error: 'TRIAL_CANCELLED' });
    const okStaff = t.day.staff.some((s) => checkState(s.check) === 'reviewed');
    if (!okStaff)
      return res.status(409).json({
        error: 'STAFF_CHECK_REQUIRED',
        message:
          'At least one named staff member needs a REVIEWED, unexpired background check before anyone checks in.',
      });
    const p = findPlayer(t.playerId);
    const minor = p && !isAdult(p);
    const requiredScope = minor ? 'guardian_event_consent' : 'player_event_consent';
    if (!t.day.consents.some((c) => c.scope === requiredScope)) {
      return res.status(409).json({
        error: 'CONSENT_REQUIRED',
        scope: requiredScope,
        message: minor
          ? 'The guardian has not given event consent for this trial day.'
          : 'The player has not given event consent for this trial day.',
      });
    }
    if (t.day.checkins.some((c) => c.playerId === t.playerId))
      return res.status(409).json({ error: 'ALREADY_CHECKED_IN' });
    const checkedInAt = Date.now();
    const fresh = unit(() => {
      // The session whose window holds this moment (from two hours before its start) gets one append-only `attended`
      // record with source `checkin`. A trial without a schedule records nothing new here.
      const by = { kind: 'org', userId: req.orgUser.id, name: req.orgUser.name };
      const sessions = t.schedule?.confirmedAt ? t.schedule.sessions : [];
      const live = sessions.find((s) => s.startsAt - 2 * 3600_000 <= checkedInAt && checkedInAt <= s.endsAt) ?? null;
      const attends = live && !t.attendance.some((a) => a.sessionId === live.id && a.state === 'attended');
      const checkedIn = trials.checkIn(
        t.id,
        {
          checkin: { playerId: t.playerId, at: checkedInAt, byUserId: req.orgUser.id, byName: req.orgUser.name },
          attendance: attends
            ? {
                sessionId: live.id,
                state: 'attended',
                source: 'checkin',
                recordedBy: by,
                recordedAt: checkedInAt,
                note: null,
              }
            : null,
        },
        attends
          ? {
              at: checkedInAt,
              bump: true,
              revBy: req.orgUser,
              history: [
                {
                  id: nextId('aud'),
                  at: checkedInAt,
                  action: 'trial_attendance_recorded',
                  by,
                  detail: { sessionId: live.id, state: 'attended', source: 'checkin' },
                },
              ],
            }
          : {},
      );
      // Feed the existing attendance record once.
      if (p && !(p.attendance ?? []).some((a) => a.trialId === t.id)) {
        playerRecord.recordAttendance(p.id, {
          id: nextId('att'),
          trialId: t.id,
          fixture: `Trial day · ${t.orgName}`,
          venue: t.venue ?? '',
          date: t.proposedDate ?? new Date().toISOString().slice(0, 10),
          gps: null,
          verified: true,
          corroboratedBy: t.orgName,
        });
        recordActivity(p);
      }
      ledgerAppend({
        type: 'trial_checkin',
        playerId: t.playerId,
        orgId: req.org.id,
        orgName: req.org.name,
        userId: req.orgUser.id,
        scoutName: req.orgUser.name,
      });
      return checkedIn;
    });
    res.json({ trial: trialDayView(fresh, 'org') });
  });

  function playerTrial(req, res, playerIds) {
    const found = trials.byId(req.params.id);
    const t = found && playerIds.includes(found.playerId) ? found : null;
    if (!t) {
      res.status(404).json({ error: 'TRIAL_NOT_FOUND' });
      return null;
    }
    return t;
  }

  function giveConsent(req, res, t, by, scope) {
    if (t.day.consents.some((c) => c.scope === scope && c.by.id === by.id))
      return res.status(409).json({ error: 'ALREADY_CONSENTED' });
    trials.giveConsent(t.id, { consent: { id: nextId('cns'), by, scope, at: Date.now() } });
    res.status(201).json({ consented: scope });
  }

  playerRouter.post('/trials/:id/consent', (req, res) => {
    if (req.playerIsMinor)
      return res
        .status(403)
        .json({ error: 'GUARDIAN_MANAGED', message: 'Event consent for under-18s comes from the guardian.' });
    const t = playerTrial(req, res, [req.player.id]);
    if (t)
      giveConsent(req, res, t, { kind: 'player', id: req.player.id, name: req.player.name }, 'player_event_consent');
  });

  guardianRouter.post('/trials/:id/consent', (req, res) => {
    const t = playerTrial(req, res, req.guardian.childIds);
    if (t)
      giveConsent(
        req,
        res,
        t,
        { kind: 'guardian', id: req.guardian.id, name: req.guardian.name },
        'guardian_event_consent',
      );
  });

  function setEmergency(req, res, t, by) {
    const body = inputOrRefuse(res, EmergencyContact, req.body ?? {});
    if (!body) return;
    const name = filled(body.name);
    const phone = filled(body.phone);
    if (!name || !phone) return res.status(400).json({ error: 'NAME_AND_PHONE_REQUIRED' });
    // Readable only in the org's trial-day view for this event; never in profiles, search or exports.
    trials.setEmergencyContact(t.id, {
      emergency: { name, phone, setBy: by, at: Date.now() },
    });
    res.json({ ok: true, note: 'Held for this event’s safety staff only.' });
  }
  playerRouter.post('/trials/:id/emergency-contact', (req, res) => {
    if (req.playerIsMinor) return res.status(403).json({ error: 'GUARDIAN_MANAGED' });
    const t = playerTrial(req, res, [req.player.id]);
    if (t) setEmergency(req, res, t, 'player');
  });
  guardianRouter.post('/trials/:id/emergency-contact', (req, res) => {
    const t = playerTrial(req, res, req.guardian.childIds);
    if (t) setEmergency(req, res, t, 'guardian');
  });

  function safetyPack(t, forGuardian) {
    return {
      trial: trialDayView(t, 'family'),
      pack: {
        staff: trialDayView(t, 'family').staff,
        headline: 'Who will be there, what has been checked, and what to do if something feels wrong.',
        checksExplained:
          'A "reviewed" check means Trust & Safety examined the club’s filed reference for that person. "Pending" means it has NOT been examined yet. We show you the truth rather than a badge.',
        arrival: t.day.arrival,
        collection: forGuardian ? t.day.collection : null,
        emergencySet: !!t.day.emergency,
        reportRoute:
          'Anything concerning: use ⚑ Report in the app — urgent reports suspend club communication immediately.',
        feedbackDue: Number.isFinite(t.reportDueAt) ? new Date(t.reportDueAt).toISOString().slice(0, 10) : null,
      },
    };
  }

  const familyTrials = (playerIds, { minorDevice = false } = {}) =>
    trials.forPlayers(playerIds).map((t) => {
      // A minor's own device gets the outcome line only, never the sessions, address, instructions or history the
      // guardian holds.
      return { ...trialDayView(t, 'family'), workflow: minorDevice ? trialOutcomeLine(t) : trialFamilyView(t) };
    });
  playerRouter.get('/trials', (req, res) =>
    res.json(familyTrials([req.player.id], { minorDevice: !!req.playerIsMinor })),
  );
  guardianRouter.get('/trials', (req, res) => res.json(familyTrials(req.guardian.childIds)));

  playerRouter.get('/trials/:id/safety-pack', (req, res) => {
    const t = playerTrial(req, res, [req.player.id]);
    if (t) res.json(safetyPack(t, false));
  });
  guardianRouter.get('/trials/:id/safety-pack', (req, res) => {
    const t = playerTrial(req, res, req.guardian.childIds);
    if (t) res.json(safetyPack(t, true));
  });

  // Jurisdiction-appropriate wording; nothing is auto-approved.
  adminRouter.get('/staff-checks', (req, res) => {
    // Oldest trial first. The admin app reads only the first page; "load more" awaits a product decision.
    const query = inputOrRefuse(res, StaffChecksQuery, req.query ?? {}, { root: 'query' });
    if (!query) return;
    let page;
    try {
      page = readPage(query, ['number', 'number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const { items, nextCursor } = trials.staffChecksPage({ pendingOnly: query.all !== '1', ...page });
    res.json({ items: items.map((r) => ({ ...r, check: { ...r.check, state: checkState(r.check) } })), nextCursor });
  });

  adminRouter.post('/staff-checks/:trialId/:staffId', (req, res) => {
    const t = trials.byId(req.params.trialId);
    const s = t?.day?.staff.find((x) => x.id === req.params.staffId);
    if (!s?.check) return res.status(404).json({ error: 'CHECK_NOT_FOUND' });
    const body = inputOrRefuse(res, StaffCheckReview, req.body ?? {}, STAFF_CHECK_CODES);
    if (!body) return;
    const { status, expiresAt } = body;
    const exp = checkExpiryOrRefuse(res, expiresAt);
    if (exp === undefined) return;
    const fresh = trials.reviewStaffCheck(t.id, {
      staffId: s.id,
      status,
      reviewedBy: 'Trust & Safety',
      reviewedAt: Date.now(),
      expiresAt: exp,
    });
    const check = fresh.day.staff.find((x) => x.id === s.id).check;
    res.json({ check: { ...check, state: checkState(check) } });
  });
}
