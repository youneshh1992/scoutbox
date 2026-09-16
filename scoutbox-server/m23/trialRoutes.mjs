/**
 * M23 P4B — Trial routes: the club side of one operational workflow, and the
 * recipient's confirmation/decline/cancel of it.
 *
 *   GET   /org/rooms/:id/trials                          trials for the case, routing, case gate
 *   POST  /org/rooms/:id/trials                          send an INVITATION (db.requests, type trial)
 *   GET   /org/rooms/:id/trials/:tid                     one trial, its evidence and its assessments
 *   POST  /org/rooms/:id/trials/:tid/schedule            propose / confirm a schedule revision
 *   POST  /org/rooms/:id/trials/:tid/reschedule          same handler; a revision of a confirmed schedule
 *   POST  /org/rooms/:id/trials/:tid/cancel              cancel (allowed while blocked — a safety notice)
 *   POST  /org/rooms/:id/trials/:tid/sessions/:sid/attendance
 *   POST  /org/rooms/:id/trials/:tid/complete            the completion gate (D-5)
 *   POST  /org/rooms/:id/trials/:tid/sessions/:sid/evidence         link a Box Cam session (N1/N2)
 *   POST  /org/rooms/:id/trials/:tid/evidence/:eid/unlink
 *   GET   /org/rooms/:id/trials/:tid/evidence            trialEvidenceView[] (N3/N4/N5)
 *   GET   /org/recruitment/trial-policy                  vocabulary
 *   POST  /player|guardian/trials/:id/confirm-schedule   recipient confirms a revision
 *   POST  /player|guardian/trials/:id/decline-schedule
 *   POST  /player|guardian/trials/:id/cancel
 *
 * There is deliberately NO acceptance route here. The recipient accepts the
 * invitation through the respond route that already exists; that route calls
 * the single Trial writer (`issueAcceptedTrial`) and then `ctx.onTrialAccepted`
 * (registered here), so the case advances through the single lifecycle writer
 * in the SAME save as the answer (P4A-D15). One Inbox, one response path, one
 * trial writer.
 *
 * WHAT NEVER HAPPENS HERE
 *
 * No `case.status = …` (only `ctx.applyLifecycleTransition`); no write to a
 * Box Cam session; no read of an assessment body; no numeric confidence or
 * score; no recipient identity trusted from a client — every recipient is
 * re-derived from the live player, organisation, guardian records and clock.
 */

import { visibleToOrg, chooseTrialSlot } from '../domain.mjs';
import { roomRole, ROOM_STATUS_LABELS, ROOM_TRANSITIONS } from '../m17/shared.mjs';
import { guardRev, bumpRev, expectedRevOf } from '../m181/concurrency.mjs';
import { rateLimitedBody } from '../m181/rateLimit.mjs';
import { PROVIDERS } from '../m16/drills.mjs';
import { STATE_COPY as CV_STATE_COPY } from '../m22/policy.mjs';
import { COMBINE_DISABLED_REASON } from '../m22/eligibility.mjs';
import { canTransitionRecruitmentCase, RECRUITMENT_LIFECYCLE_POLICY_VERSION } from './lifecycle.mjs';
import { sendDomainError, httpStatusFor } from './errors.mjs';
import { resolveContactRecipient, CONTACT_LIMITS } from './contact.mjs';
import {
  TRIAL_POLICY_VERSION, TRIAL_LIMITS, TRIAL_WORKFLOW_STATES, TRIAL_SESSION_KINDS, TRIAL_ATTENDANCE_STATES,
  TRIAL_CANCEL_ACTORS, trialRoleAllows, normaliseTrialClientKey, payloadFingerprint,
  validateTimezone, validateVenue, validateSessionInput, validateScheduleInput, materialChange,
  deriveWorkflowState, isLegacyTrial, currentAttendance, canComplete, trialStateAllows, blockedAllows,
  trialIntegrity, trialClubView, trialFamilyView, localDay, byStartsAtThenId, parseInstant,
} from './trial.mjs';

export function registerTrial(ctx) {
  const {
    db, orgRouter, playerRouter, guardianRouter, nextId, persistNow, notify, broadcast, findPlayer, isBlocked, isAdult,
    rateLimit, isLead, moderateOrRefuse, issueRecruitmentRequest, audit, orgCanSee, guardianManagedOnly,
    combineOrgMaySeeResults, testProviderEnabled = false,
  } = ctx;

  /**
   * ONE clock per request. In a test deployment (SCOUTBOX_TEST_CLOCK=1) a
   * suite may pin it with `x-scoutbox-test-clock: <ms>` so that "the last
   * session has ended" can be proven without waiting for it to. Production
   * ignores the header entirely.
   */
  const TEST_CLOCK = process.env.SCOUTBOX_TEST_CLOCK === '1';
  const now = (req = null) => {
    if (TEST_CLOCK && req?.get) {
      const n = Number(req.get('x-scoutbox-test-clock'));
      if (Number.isFinite(n) && n > 0) return n;
    }
    return Date.now();
  };
  const limited = (action, keyPart) => !!rateLimit?.limited(action, keyPart);
  const err = (res, error, message, extra = {}) => sendDomainError(res, { error, message, ...extra }, 'trial');
  const orgActor = (req) => ({ kind: 'org', userId: req.orgUser.id, name: req.orgUser.name });
  const orgOf = (orgId) => (db.orgs ?? []).find((o) => o.id === orgId) ?? null;
  const roleFor = (req, room) => roomRole({ room, user: req.orgUser, isLead: isLead(req.orgUser) });
  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /** One history entry, ONE clock. */
  const record = (t, action, by, detail, at) => {
    t.history ??= [];
    t.history.push({ id: nextId('aud'), at, action, by, detail: detail ?? null });
  };

  /** Idempotency keys are per action, bounded, with a payload fingerprint. */
  function keyCheck(t, action, key, fp) {
    if (!key) return { replay: false };
    const list = Array.isArray(t.keys?.[action]) ? t.keys[action] : [];
    const prior = list.find((k) => k.key === key);
    if (!prior) return { replay: false };
    return prior.fp === fp ? { replay: true } : { conflict: true };
  }
  function keyRecord(t, action, key, fp, at) {
    if (!key) return;
    t.keys ??= {};
    if (!Array.isArray(t.keys[action])) t.keys[action] = [];
    t.keys[action].push({ key, fp, at });
    if (t.keys[action].length > 50) t.keys[action].shift();
  }

  /** The case statuses from which a trial may be requested: every in-edge of `trial_requested`, plus itself (a second invitation after a decline). */
  const TRIAL_CASE_STATUSES = Object.freeze([
    ...Object.keys(ROOM_TRANSITIONS).filter((s) => (ROOM_TRANSITIONS[s] ?? []).includes('trial_requested')),
    'trial_requested',
  ]);

  // ------------------------------------------------------------- lookups

  function roomFor(req, res, need) {
    const room = ctx.findRoomForRequest(req, res);
    if (!room) return null;
    const role = roleFor(req, room);
    if (!trialRoleAllows(role, need)) {
      err(res, 'TRIAL_NOT_PERMITTED', need === 'trial_write'
        ? 'Only a room lead or recruitment lead can invite, schedule, cancel, record attendance, complete or link evidence for a trial.'
        : need === 'trial_assess' ? 'Your role cannot assess in this room.' : 'Your role cannot read trials in this room.');
      return null;
    }
    return { room, role };
  }

  function storeOr500(res) {
    if (!Array.isArray(db.trials)) {
      console.error('TRIAL store_missing db.trials is absent or not a list');
      err(res, 'TRIAL_STORE_MISSING', 'Trials cannot be served right now.');
      return null;
    }
    return db.trials;
  }

  /** This case's trials (case-bound) plus this org's legacy trials for the same player (read-only interpretation), corrupt rows omitted and counted. */
  function trialsOf(room) {
    const good = [];
    let omitted = 0;
    for (const t of db.trials ?? []) {
      if (!t || t.orgId !== room.orgId || t.playerId !== room.playerId) continue;
      if (t.caseId && t.caseId !== room.id) continue;
      const problems = trialIntegrity(t, { orgId: room.orgId, caseId: t.caseId ? room.id : null });
      if (problems.length) { omitted += 1; console.error(`TRIAL integrity ${t.id ?? '?'}: ${problems.join(',')}`); continue; }
      good.push(t);
    }
    good.sort((a, b) => (a.acceptedAt - b.acceptedAt) || String(a.id).localeCompare(String(b.id)));
    return { list: good, omitted };
  }

  function findTrial(req, res, room) {
    if (!storeOr500(res)) return null;
    const t = db.trials.find((x) => x && x.id === req.params.tid && x.orgId === room.orgId && x.playerId === room.playerId && (!x.caseId || x.caseId === room.id));
    if (!t) { err(res, 'TRIAL_NOT_FOUND', 'No such trial.'); return null; }
    const problems = trialIntegrity(t, { orgId: room.orgId, caseId: t.caseId ? room.id : null });
    if (problems.length) {
      console.error(`TRIAL integrity ${t.id}: ${problems.join(',')}`);
      err(res, 'TRIAL_STATE_UNKNOWN', 'This trial cannot be read.');
      return null;
    }
    return t;
  }

  function findSession(res, t, sid) {
    const s = (t.schedule?.sessions ?? []).find((x) => x.id === sid) ?? null;
    if (!s) { err(res, 'TRIAL_SESSION_NOT_FOUND', 'No such session on this trial.'); return null; }
    return s;
  }

  /** The recipient rule, in Trial vocabulary. Computed now, never trusted from a client. */
  const RECIPIENT_CODES = Object.freeze({ CONTACT_BLOCKED: 'TRIAL_BLOCKED', CONTACT_GUARDIAN_REQUIRED: 'TRIAL_GUARDIAN_REQUIRED', CONTACT_RECIPIENT_UNAVAILABLE: 'TRIAL_RECIPIENT_UNAVAILABLE' });
  function recipientFor(org, playerId) {
    const r = resolveContactRecipient({ player: findPlayer(playerId), org, guardians: db.guardians ?? [], isAdult, visibleToOrg, isBlocked, now: new Date() });
    if (r.ok) return r;
    const error = RECIPIENT_CODES[r.error] ?? 'TRIAL_RECIPIENT_UNAVAILABLE';
    return { ok: false, error, message: error === 'TRIAL_GUARDIAN_REQUIRED' ? 'This player is under the age of majority and no valid guardian route exists. The trial cannot proceed.' : error === 'TRIAL_BLOCKED' ? 'This player (or their guardian) has blocked your organisation.' : r.message };
  }
  const routingView = (r) => (r.ok ? { available: true, type: r.recipient.type, minor: r.recipient.minor } : { available: false, type: null, minor: null, reason: r.error });

  /**
   * RE-AUTHORISATION on every club mutation (architecture §11, mandate
   * §28–§32, §40–§44), in order: role (done by roomFor), org membership
   * (orgAuth), block policy (D-16), recipient validity (visibility, club
   * verification for minors, guardian route) for the actions that reach the
   * recipient, subject removed, state.
   */
  function reauth(req, res, room, t, action) {
    if (t?.subjectRemovedAt) { err(res, 'TRIAL_SUBJECT_REMOVED', 'This player removed their ScoutBox account. The trial stays on record; it can no longer be changed.'); return null; }
    if (isBlocked(room.playerId, room.orgId) && !blockedAllows(action)) {
      err(res, 'TRIAL_BLOCKED', 'This player (or their guardian) has blocked your organisation. You may cancel the trial; nothing else.');
      return null;
    }
    const needsRecipient = ['invite', 'schedule', 'reschedule', 'link'].includes(action);
    let recipient = null;
    if (needsRecipient) {
      const r = recipientFor(req.org, room.playerId);
      if (!r.ok) { err(res, r.error, r.message); return null; }
      recipient = r.recipient;
    }
    if (t && action !== 'invite' && !trialStateAllows(t, action)) {
      err(res, 'TRIAL_INVALID_STATE', `A trial that is ${deriveWorkflowState(t).replace('_', ' ')} cannot take this action.`, { current: { workflowState: deriveWorkflowState(t) } });
      return null;
    }
    return { recipient };
  }

  /** `expectedRev` is REQUIRED on a mutation of an existing trial; absent is refused, never coerced. */
  function revGate(req, res, t) {
    const exp = expectedRevOf(req.body);
    if (exp === null) { err(res, 'TRIAL_REV_REQUIRED', 'expectedRev is required: send the rev you were looking at.'); return false; }
    // No coercion (mandate §63): a rev is a JSON integer, never "3", 3.5, -1,
    // an object or a list. The shared guard folds numeric strings; the Trial
    // does not.
    const rawRev = req.body?.expectedRev ?? req.body?.expectedVersion;
    if (!Number.isInteger(rawRev) || rawRev < 0) { err(res, 'TRIAL_REV_REQUIRED', 'expectedRev must be a non-negative integer.', { field: 'expectedRev', expected: 'integer' }); return false; }
    return guardRev(req, res, t, { errorCode: 'TRIAL_VERSION_CONFLICT', current: { workflowState: deriveWorkflowState(t) } });
  }

  /**
   * The lifecycle coupling. The Trial never writes a case status: it asks the
   * ONE validator whether the semantic action is possible — with the real
   * evidence provider, which now sees this request or trial — and, if so,
   * writes through the ONE status writer. A recipient-driven advance names
   * the recipient as actor; a club-driven one names the club user.
   */
  function advanceCase({ req = null, room, action, at, trigger, actor = null, keyDetail = {} }) {
    const role = req ? roleFor(req, room) : 'recruitment_admin';
    const verdict = canTransitionRecruitmentCase(room, action, { role, evidence: ctx.recruitmentEvidenceProvider, now: at });
    if (verdict.ok) {
      const org = orgOf(room.orgId);
      const { from, to } = ctx.applyLifecycleTransition({ req, room, to: verdict.to, reasonCodes: [], trigger, actor: actor ? { ...actor, org } : null });
      const last = room.history[room.history.length - 1];
      if (last?.action === 'room_status_changed') {
        last.detail = { ...last.detail, lifecycleAction: action, clientKey: null, policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION, ...keyDetail };
      }
      return { applied: true, from, to, at };
    }
    if (verdict.error !== 'LIFECYCLE_NO_CHANGE') console.error(`TRIAL lifecycle_not_applied ${room.id} ${action} ${verdict.error} ${verdict.evidenceReason ?? ''}`);
    return { applied: false, reason: verdict.error, at };
  }

  /** The routed recipient's notification audience (guardian for minors). */
  function recipientAudience(t) {
    const p = findPlayer(t.playerId);
    if (!p) return null;
    if (isAdult(p)) return { kind: 'player', id: p.id };
    const r = recipientFor(orgOf(t.orgId) ?? { id: t.orgId }, p.id);
    if (r.ok && r.recipient.type === 'guardian') return { kind: 'guardian', id: r.recipient.guardianId };
    // No valid guardian route: the child's own device carries the outcome line only.
    return t.recipient?.guardianId ? { kind: 'guardian', id: t.recipient.guardianId } : null;
  }
  function notifyRecipient(t, text) {
    const a = recipientAudience(t);
    if (a) notify(a, 'trial_day', text, t.id);
  }
  function notifyClub(t, text) {
    const room = (db.recruitmentCases ?? []).find((k) => k?.id === t.caseId);
    const request = (db.requests ?? []).find((r) => r?.id === t.requestId);
    const ids = new Set([request?.userId, room?.ownerUserId, room?.room?.leadScoutUserId].filter(Boolean));
    for (const uid of ids) notify({ kind: 'org_user', id: uid }, 'trial_day', text, t.id);
  }

  // ---------------------------------------------------------------- list

  orgRouter.get('/rooms/:id/trials', (req, res) => {
    const got = roomFor(req, res, 'trial_view');
    if (!got) return;
    if (!storeOr500(res)) return;
    const { room, role } = got;
    const { list, omitted } = trialsOf(room);
    const routing = recipientFor(req.org, room.playerId);
    const invitation = (db.requests ?? []).filter((r) => r && r.type === 'trial' && r.caseId === room.id && r.orgId === room.orgId)
      .sort((a, b) => (b.createdAt - a.createdAt) || String(b.id).localeCompare(String(a.id)))[0] ?? null;
    res.json({
      items: list.map(trialClubView),
      omitted,
      routing: routingView(routing),
      invitation: invitation ? invitationView(invitation) : null,
      case: { status: room.room.status, acceptsInvitation: TRIAL_CASE_STATUSES.includes(room.room.status), planAction: 'planTrial' },
      canWrite: trialRoleAllows(role, 'trial_write'),
      canAssess: trialRoleAllows(role, 'trial_assess'),
      blocked: isBlocked(room.playerId, room.orgId),
      limits: TRIAL_LIMITS,
      vocabulary: { workflowStates: TRIAL_WORKFLOW_STATES, sessionKinds: TRIAL_SESSION_KINDS, attendanceStates: TRIAL_ATTENDANCE_STATES },
      policyVersion: TRIAL_POLICY_VERSION,
      note: 'An invitation is not a trial. A trial exists once the player or guardian accepts; it is scheduled once a concrete schedule is confirmed; it is completed only after recorded attendance and the last session has ended.',
    });
  });

  function invitationView(r) {
    const td = r.trialDetails ?? {};
    return {
      id: r.id, status: r.status, createdAt: r.createdAt, respondedAt: r.respondedAt ?? null, respondedBy: r.respondedBy ?? null,
      routedTo: r.routedTo ?? null, trialId: r.trialId ?? null,
      slots: (td.slots ?? []).map((s) => ({ id: s.id, day: s.day, startsAt: s.startsAt, endsAt: s.endsAt, timezone: s.timezone, kind: s.kind ?? null, venue: s.venue ? { name: s.venue.name, town: s.venue.town ?? null } : null })),
      proposedDate: td.proposedDate ?? null, altSlots: td.altSlots ?? [],
    };
  }

  // ---------------------------------------------------------- invitation

  /**
   * The invitation body: 1–3 slots (each a UTC instant pair in the organiser
   * timezone), a venue (name + town shared now; address after acceptance), a
   * message, optional post-acceptance instructions. Every slot lands on a
   * distinct calendar day in the organiser zone, because the recipient picks
   * a DAY through the existing Inbox (`chosenSlot`).
   */
  function validateInvitation(body, { now: at }) {
    const bad = (error, message, extra = {}) => ({ ok: false, error, message, ...extra });
    if (!isPlain(body)) return bad('TRIAL_CONTENT_INVALID', 'The invitation must be an object.');
    const tz = validateTimezone(body.timezone);
    if (!tz.ok) return tz;
    if (!Array.isArray(body.slots) || body.slots.length === 0) return { ok: false, error: 'TRIAL_SLOTS_INVALID', message: 'Offer at least one slot.', field: 'slots' };
    if (body.slots.length > TRIAL_LIMITS.slots) return bad('TRIAL_SLOTS_INVALID', `Offer at most ${TRIAL_LIMITS.slots} slots.`, { field: 'slots' });
    const venue = validateVenue(body.venue);
    if (!venue.ok) return venue;
    const slots = [];
    const days = new Set();
    for (const raw of body.slots) {
      if (!isPlain(raw)) return bad('TRIAL_SLOTS_INVALID', 'Each slot is an object with startsAt and endsAt.', { field: 'slots' });
      const v = validateSessionInput({ ...raw, venue: venue.venue }, { now: at });
      if (!v.ok) return v;
      const day = localDay(v.session.startsAt, tz.timezone);
      if (days.has(day)) return bad('TRIAL_SLOTS_INVALID', 'Each offered slot must fall on a different day.', { field: 'slots' });
      days.add(day);
      slots.push({ id: nextId('tslot'), day, kind: v.session.kind, startsAt: v.session.startsAt, endsAt: v.session.endsAt, timezone: tz.timezone, venue: { name: venue.venue.name, town: venue.venue.town ?? null } });
    }
    slots.sort((a, b) => a.startsAt - b.startsAt);
    if (typeof body.message !== 'string' || !body.message.trim()) return bad('TRIAL_CONTENT_INVALID', 'Write the message the player or guardian will read.', { field: 'message' });
    if (body.message.length > TRIAL_LIMITS.message) return bad('TRIAL_CONTENT_INVALID', `Keep the message under ${TRIAL_LIMITS.message} characters.`, { field: 'message' });
    let instructions = null;
    if (body.instructions !== undefined && body.instructions !== null && body.instructions !== '') {
      if (typeof body.instructions !== 'string') return bad('TRIAL_CONTENT_INVALID', 'Instructions must be text.', { field: 'instructions' });
      if (body.instructions.length > TRIAL_LIMITS.instructions) return bad('TRIAL_CONTENT_INVALID', `Keep the instructions under ${TRIAL_LIMITS.instructions} characters.`, { field: 'instructions' });
      instructions = body.instructions.trim() || null;
    }
    return { ok: true, timezone: tz.timezone, slots, venue: venue.venue, message: body.message.trim(), instructions };
  }

  orgRouter.post('/rooms/:id/trials', (req, res) => {
    const got = roomFor(req, res, 'trial_write');
    if (!got) return;
    const { room } = got;
    if (!storeOr500(res)) return;
    const at = now(req);

    const key = normaliseTrialClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const inv = validateInvitation(req.body, { now: at });
    if (!inv.ok) return err(res, inv.error, inv.message, inv.field ? { field: inv.field } : (inv.allowed ? { allowed: inv.allowed } : {}));
    const fp = payloadFingerprint({ slots: inv.slots.map((s) => [s.startsAt, s.endsAt]), venue: inv.venue.name, message: inv.message });

    // Replay of the same invitation: the same request row, not a second one.
    const mine = (db.requests ?? []).filter((r) => r && r.type === 'trial' && r.caseId === room.id && r.orgId === room.orgId);
    if (key.key) {
      const prior = mine.find((r) => r.keys?.invite?.key === key.key);
      if (prior && prior.keys.invite.fp === fp) return res.json({ invitation: invitationView(prior), idempotent: true, case: { unchanged: true, status: room.room.status } });
      if (prior) return err(res, 'TRIAL_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different invitation.');
    }

    // The case gate: one gate, the case status (D-3). The club plans a trial
    // from where the lifecycle allows `trial_requested`.
    if (!TRIAL_CASE_STATUSES.includes(room.room.status)) {
      return err(res, 'TRIAL_CASE_STATE', `A case at "${ROOM_STATUS_LABELS[room.room.status] ?? room.room.status}" cannot request a trial.`, { allowed: TRIAL_CASE_STATUSES });
    }
    // One live invitation at a time; one open trial at a time.
    const pending = mine.find((r) => r.status === 'pending');
    if (pending) return err(res, 'TRIAL_ALREADY_INVITED', 'An invitation is already waiting for an answer.', { current: { requestId: pending.id } });
    const openTrial = trialsOf(room).list.find((t) => t.caseId === room.id && !['completed', 'cancelled'].includes(deriveWorkflowState(t)));
    if (openTrial) return err(res, 'TRIAL_INVALID_STATE', 'This case already has an open trial. Complete or cancel it before inviting again.', { current: { trialId: openTrial.id, workflowState: deriveWorkflowState(openTrial) } });
    // Deterministic anti-spam: a declined invitation cannot be followed by
    // another to the same player within the Contact cooldown window.
    const declined = mine.filter((r) => r.status === 'declined' && Number.isFinite(r.respondedAt) && at - r.respondedAt < CONTACT_LIMITS.cooldownMs);
    if (declined.length) {
      const latest = Math.max(...declined.map((r) => r.respondedAt));
      return err(res, 'TRIAL_INVITE_COOLDOWN', 'This player declined a trial invitation recently. Wait before inviting again.', { retryAt: latest + CONTACT_LIMITS.cooldownMs });
    }
    if (limited('trial_invite', req.org.id)) return res.status(429).json(rateLimitedBody('trial_invite'));

    // RE-DERIVED NOW: block, visibility (agency / unverified club walls), guardian route.
    const auth = reauth(req, res, room, null, 'invite');
    if (!auth) return;
    const recipient = auth.recipient;
    const player = findPlayer(room.playerId);
    if (!moderateOrRefuse(res, inv.message, { kind: 'trial_invitation', orgId: req.org.id, userId: req.orgUser.id })) return;
    if (inv.instructions && !moderateOrRefuse(res, inv.instructions, { kind: 'trial_instructions', orgId: req.org.id, userId: req.orgUser.id })) return;

    // Failure injection (M13 mechanism): the transport refuses, NOTHING is
    // written — no request row, no case move, no notification.
    const inject = db.deliveryFailInject;
    if (inject && Number(inject.trial ?? 0) > 0) {
      inject.trial = Number(inject.trial) - 1;
      persistNow();
      console.error(`TRIAL transport_failed invitation case=${room.id}`);
      return err(res, 'TRIAL_TRANSPORT_REFUSED', 'The invitation could not be delivered. Nothing was sent; try again.');
    }

    const request = issueRecruitmentRequest({
      org: req.org, orgUser: req.orgUser, player, type: 'trial', message: inv.message,
      trialDetails: {
        proposedDate: inv.slots[0].day, altSlots: inv.slots.slice(1).map((s) => s.day),
        venue: inv.venue.town ? `${inv.venue.name}, ${inv.venue.town}` : inv.venue.name, notes: '',
        slots: inv.slots,
        // Shared with the routed recipient AFTER acceptance only (D-23);
        // stripped from every recipient-facing view of the request.
        private: { venueAddress: inv.venue.address ?? null, instructions: inv.instructions },
      },
      guardianId: recipient.guardianId, at,
    }, { persist: false });
    request.caseId = room.id;
    request.trialId = null;
    request.recipient = recipient;
    request.keys = { invite: key.key ? { key: key.key, fp } : null };
    room.links ??= { requestIds: [], trialIds: [], signingId: null };
    if (!room.links.requestIds.includes(request.id)) room.links.requestIds.push(request.id);
    audit(room, 'org', req.orgUser.id, req.orgUser.name, 'room_trial_invited', { requestId: request.id, recipientType: recipient.type, slotCount: inv.slots.length });

    const moved = advanceCase({ req, room, action: 'planTrial', at, trigger: `trial:invite:${request.id}`, keyDetail: { requestId: request.id } });
    persistNow();
    broadcast('trial_invited', { orgId: room.orgId, roomId: room.id, requestId: request.id });
    res.status(201).json({ invitation: invitationView(request), routing: routingView({ ok: true, recipient }), case: moved.applied ? { from: moved.from, to: moved.to } : { unchanged: true, status: room.room.status } });
  });

  // ------------------------------------------------------------- one trial

  orgRouter.get('/rooms/:id/trials/:tid', (req, res) => {
    const got = roomFor(req, res, 'trial_view');
    if (!got) return;
    const t = findTrial(req, res, got.room);
    if (!t) return;
    res.json({ trial: trialClubView(t), evidence: evidenceViews(t), assessments: assessmentsFor(req, t), canWrite: trialRoleAllows(got.role, 'trial_write'), canAssess: trialRoleAllows(got.role, 'trial_assess'), blocked: isBlocked(t.playerId, t.orgId) });
  });

  /** Assessments in this trial's context that THIS user may see (the M12 blind rule). Existence and state only. */
  function assessmentsFor(req, t) {
    const mine = (db.assessments ?? []).filter((a) => a && a.orgId === t.orgId && a.playerId === t.playerId && a.context?.trialId === t.id);
    const lead = isLead(req.orgUser);
    const iSubmitted = mine.some((a) => a.scoutUserId === req.orgUser.id && a.state !== 'draft');
    return mine
      .filter((a) => lead || a.scoutUserId === req.orgUser.id || (iSubmitted && a.state !== 'draft'))
      .map((a) => ({ id: a.id, state: a.state, scoutName: a.scoutName, scoutUserId: a.scoutUserId, submittedAt: a.submittedAt ?? null, trialSessionId: a.context?.trialSessionId ?? null, published: !!a.publishedFeedback }));
  }

  // -------------------------------------------------------------- schedule

  function scheduleHandler(req, res) {
    const got = roomFor(req, res, 'trial_write');
    if (!got) return;
    const { room } = got;
    const t = findTrial(req, res, room);
    if (!t) return;
    const at = now(req);
    const key = normaliseTrialClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);

    const existingIds = (t.schedule?.sessions ?? []).map((s) => s.id);
    const check = validateScheduleInput(req.body, { now: at, mintId: () => nextId('tses'), existingIds });
    if (!check.ok) return err(res, check.error, check.message, check.field ? { field: check.field } : (check.allowed ? { allowed: check.allowed } : {}));
    const fp = payloadFingerprint({ timezone: check.schedule.timezone, sessions: check.schedule.sessions.map((s) => [s.id, s.startsAt, s.endsAt, s.venue?.name, s.venue?.town, s.kind, s.instructions ?? null]) });
    const kc = keyCheck(t, 'schedule', key.key, fp);
    if (kc.conflict) return err(res, 'TRIAL_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different schedule.');
    if (kc.replay) return res.json({ trial: trialClubView(t), idempotent: true });

    const isRevision = !!t.schedule;
    const auth = reauth(req, res, room, t, isRevision ? 'reschedule' : 'schedule');
    if (!auth) return;
    if (!revGate(req, res, t)) return;
    if (limited('trial_schedule', req.org.id)) return res.status(429).json(rateLimitedBody('trial_schedule'));
    if ((t.schedule?.revisions?.length ?? 0) >= TRIAL_LIMITS.revisions) return err(res, 'TRIAL_INVALID_STATE', `A trial schedule may be revised at most ${TRIAL_LIMITS.revisions} times.`);

    // Ended sessions are history: a revision must carry every session that
    // has already ended, unchanged, and every session that has attendance
    // recorded (mandate §56, §66). Corrections to what happened are refused
    // here — attendance has its own append-only route.
    const att = currentAttendance(t);
    for (const prev of t.schedule?.sessions ?? []) {
      const ended = prev.endsAt <= at;
      const recorded = att.has(prev.id);
      if (!ended && !recorded) continue;
      const kept = check.schedule.sessions.find((s) => s.id === prev.id);
      if (!kept || kept.startsAt !== prev.startsAt || kept.endsAt !== prev.endsAt) {
        return err(res, 'TRIAL_INVALID_STATE', 'A session that has ended or has attendance recorded cannot be removed or moved. Cancel the trial if it will not go ahead.', { current: { sessionId: prev.id } });
      }
    }
    for (const s of check.schedule.sessions) {
      if (s.instructions && !moderateOrRefuse(res, s.instructions, { kind: 'trial_instructions', orgId: req.org.id, userId: req.orgUser.id })) return;
    }

    const by = orgActor(req);
    const prevSessionsById = new Map((t.schedule?.sessions ?? []).map((s) => [s.id, s]));
    const sessions = check.schedule.sessions.map((s) => ({ ...s, evidence: prevSessionsById.get(s.id)?.evidence ?? [] }));
    const material = materialChange(t.schedule, { timezone: check.schedule.timezone, sessions });
    const revision = (t.schedule?.revision ?? 0) + 1;
    const wasConfirmed = !!t.schedule?.confirmedAt;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, TRIAL_LIMITS.reason) || null : null;

    if (t.schedule) {
      for (const r of t.schedule.revisions) if (!r.supersededAt) r.supersededAt = at;
    }
    const revisions = [...(t.schedule?.revisions ?? []), {
      revision, timezone: check.schedule.timezone, sessions: sessions.map((s) => ({ ...s, evidence: undefined })),
      proposedAt: at, proposedBy: by, confirmedAt: null, confirmedBy: null, supersededAt: null, reason, material,
    }];
    // A material change asks the recipient again (D-8); a cosmetic one keeps
    // the confirmation the recipient already gave.
    const keepsConfirmation = wasConfirmed && !material;
    t.schedule = {
      timezone: check.schedule.timezone, revision, proposedAt: at, proposedBy: by,
      confirmedAt: keepsConfirmation ? t.schedule.confirmedAt : null,
      confirmedBy: keepsConfirmation ? t.schedule.confirmedBy : null,
      declinedAt: null, declinedBy: null,
      sessions, revisions,
    };
    if (keepsConfirmation) revisions[revisions.length - 1].confirmedAt = t.schedule.confirmedAt;
    t.workflowState = deriveWorkflowState(t);
    record(t, isRevision ? 'trial_rescheduled' : 'trial_schedule_proposed', by, { revision, sessionCount: sessions.length, material, requiresConfirmation: !keepsConfirmation }, at);
    keyRecord(t, 'schedule', key.key, fp, at);
    bumpRev(t, { by: req.orgUser, at });
    persistNow();
    if (isRevision) broadcast('trial_rescheduled', { orgId: room.orgId, roomId: room.id, trialId: t.id });
    else broadcast('trial_scheduled', { orgId: room.orgId, roomId: room.id, trialId: t.id });
    notifyRecipient(t, keepsConfirmation
      ? `${t.orgName} updated the details of your trial (times unchanged).`
      : isRevision ? `${t.orgName} proposed new times for your trial — please confirm the updated schedule.` : `${t.orgName} proposed a schedule for your trial — please confirm it.`);
    res.json({ trial: trialClubView(t), requiresConfirmation: !keepsConfirmation, material });
  }
  orgRouter.post('/rooms/:id/trials/:tid/schedule', scheduleHandler);
  orgRouter.post('/rooms/:id/trials/:tid/reschedule', scheduleHandler);

  // ---------------------------------------------------------------- cancel

  orgRouter.post('/rooms/:id/trials/:tid/cancel', (req, res) => {
    const got = roomFor(req, res, 'trial_write');
    if (!got) return;
    const { room } = got;
    const t = findTrial(req, res, room);
    if (!t) return;
    const at = now(req);
    const key = normaliseTrialClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const reasonRaw = req.body?.reason;
    if (typeof reasonRaw !== 'string' || !reasonRaw.trim()) return err(res, 'TRIAL_CONTENT_INVALID', 'A cancellation needs a reason the family will read.', { field: 'reason' });
    if (reasonRaw.length > TRIAL_LIMITS.reason) return err(res, 'TRIAL_CONTENT_INVALID', `Keep the reason under ${TRIAL_LIMITS.reason} characters.`, { field: 'reason' });
    const reason = reasonRaw.trim();
    const fp = payloadFingerprint({ reason });
    const kc = keyCheck(t, 'cancel', key.key, fp);
    if (kc.conflict) return err(res, 'TRIAL_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different cancellation.');
    if (kc.replay) return res.json({ trial: trialClubView(t), idempotent: true });
    // Cancelling is allowed while blocked (a safety notice, not solicitation).
    const auth = reauth(req, res, room, t, 'cancel');
    if (!auth) return;
    if (!revGate(req, res, t)) return;
    if (limited('trial_schedule', req.org.id)) return res.status(429).json(rateLimitedBody('trial_schedule'));
    if (!moderateOrRefuse(res, reason, { kind: 'trial_cancellation', orgId: req.org.id, userId: req.orgUser.id })) return;
    const by = orgActor(req);
    const phase = deriveWorkflowState(t);
    t.completion = { state: 'cancelled', at, by, reason, phase, cancelledBy: 'club' };
    t.workflowState = 'cancelled';
    record(t, 'trial_cancelled', by, { phase, cancelledBy: 'club', attendedSessions: [...currentAttendance(t).values()].filter((a) => ['attended', 'partial'].includes(a.state)).length }, at);
    keyRecord(t, 'cancel', key.key, fp, at);
    bumpRev(t, { by: req.orgUser, at });
    persistNow();
    broadcast('trial_cancelled', { orgId: room.orgId, roomId: room.id, trialId: t.id });
    notifyRecipient(t, `${t.orgName} cancelled the trial: ${reason}`);
    res.json({ trial: trialClubView(t) });
  });

  // ------------------------------------------------------------ attendance

  orgRouter.post('/rooms/:id/trials/:tid/sessions/:sid/attendance', (req, res) => {
    const got = roomFor(req, res, 'trial_write');
    if (!got) return;
    const { room } = got;
    const t = findTrial(req, res, room);
    if (!t) return;
    const at = now(req);
    const key = normaliseTrialClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const state = req.body?.state;
    if (!TRIAL_ATTENDANCE_STATES.includes(state)) return err(res, 'TRIAL_ATTENDANCE_INVALID', `Attendance must be one of ${TRIAL_ATTENDANCE_STATES.join(', ')}. It records what happened, never how it went.`, { allowed: TRIAL_ATTENDANCE_STATES });
    const noteRaw = req.body?.note;
    if (noteRaw !== undefined && noteRaw !== null && (typeof noteRaw !== 'string' || noteRaw.length > TRIAL_LIMITS.note)) return err(res, 'TRIAL_ATTENDANCE_INVALID', `A note is text under ${TRIAL_LIMITS.note} characters.`);
    const note = typeof noteRaw === 'string' && noteRaw.trim() ? noteRaw.trim() : null;
    const fp = payloadFingerprint({ sessionId: req.params.sid, state, note });
    const kc = keyCheck(t, 'attendance', key.key, fp);
    if (kc.conflict) return err(res, 'TRIAL_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different attendance record.');
    if (kc.replay) return res.json({ trial: trialClubView(t), idempotent: true });
    const auth = reauth(req, res, room, t, 'attendance');
    if (!auth) return;
    const s = findSession(res, t, req.params.sid);
    if (!s) return;
    if (s.startsAt > at) return err(res, 'TRIAL_INVALID_STATE', 'Attendance is recorded once a session has started.', { current: { sessionId: s.id, startsAt: s.startsAt } });
    if (!revGate(req, res, t)) return;
    if (limited('trial_attendance', req.org.id)) return res.status(429).json(rateLimitedBody('trial_attendance'));
    if (note && !moderateOrRefuse(res, note, { kind: 'trial_attendance_note', orgId: req.org.id, userId: req.orgUser.id })) return;
    const by = orgActor(req);
    t.attendance ??= [];
    t.attendance.push({ sessionId: s.id, state, source: 'manual', recordedBy: by, recordedAt: at, note });
    record(t, 'trial_attendance_recorded', by, { sessionId: s.id, state, source: 'manual' }, at);
    keyRecord(t, 'attendance', key.key, fp, at);
    bumpRev(t, { by: req.orgUser, at });
    persistNow();
    broadcast('trial_attendance_recorded', { orgId: room.orgId, roomId: room.id, trialId: t.id, sessionId: s.id });
    res.json({ trial: trialClubView(t) });
  });

  // -------------------------------------------------------------- complete

  orgRouter.post('/rooms/:id/trials/:tid/complete', (req, res) => {
    const got = roomFor(req, res, 'trial_write');
    if (!got) return;
    const { room } = got;
    const t = findTrial(req, res, room);
    if (!t) return;
    const at = now(req);
    const key = normaliseTrialClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const fp = payloadFingerprint({ complete: t.id });
    const kc = keyCheck(t, 'complete', key.key, fp);
    if (kc.conflict) return err(res, 'TRIAL_IDEMPOTENCY_CONFLICT', 'This clientKey was already used differently.');
    if (kc.replay) return res.json({ trial: trialClubView(t), idempotent: true });
    const auth = reauth(req, res, room, t, 'complete');
    if (!auth) return;
    const gate = canComplete(t, { now: at });
    if (!gate.ok) return err(res, gate.error, gate.message, gate.reasons ? { reasons: gate.reasons } : {});
    if (!revGate(req, res, t)) return;
    if (limited('trial_attendance', req.org.id)) return res.status(429).json(rateLimitedBody('trial_attendance'));
    if (db.deliveryFailInject && Number(db.deliveryFailInject.trial ?? 0) > 0) {
      db.deliveryFailInject.trial = Number(db.deliveryFailInject.trial) - 1;
      persistNow();
      return err(res, 'TRIAL_TRANSPORT_REFUSED', 'The completion could not be recorded. Nothing was changed; try again.');
    }
    const by = orgActor(req);
    t.completion = { state: 'completed', at, by, reason: null, phase: 'scheduled' };
    t.workflowState = 'completed';
    record(t, 'trial_completed', by, { sessionCount: t.schedule.sessions.length, attendedSessions: [...currentAttendance(t).values()].filter((a) => ['attended', 'partial'].includes(a.state)).length }, at);
    keyRecord(t, 'complete', key.key, fp, at);
    bumpRev(t, { by: req.orgUser, at });
    // The case advances THROUGH the single writer, in the same save (D-5).
    const moved = t.caseId ? advanceCase({ req, room, action: 'completeTrial', at, trigger: `trial:complete:${t.id}`, keyDetail: { trialId: t.id } }) : { applied: false, reason: 'legacy_no_case', at };
    t.lifecycle = moved;
    persistNow();
    broadcast('trial_completed', { orgId: room.orgId, roomId: room.id, trialId: t.id });
    notifyRecipient(t, `${t.orgName} recorded the trial as completed. Thank you for taking part.`);
    res.json({ trial: trialClubView(t), case: moved.applied ? { from: moved.from, to: moved.to } : { unchanged: true, status: room.room.status, reason: moved.reason ?? null } });
  });

  // ------------------------------------------------------- Box Cam evidence

  /**
   * Link authorisation (classification N2). Every condition is checked NOW
   * against the live session, player and organisation. A session that fails
   * any of them answers `TRIAL_BOXCAM_INCOMPATIBLE` (404-band: the club
   * cannot tell "not yours" from "does not exist"), except the two states a
   * club may legitimately learn about a session it may see: not final, and
   * withdrawn.
   */
  function linkAuthorisation(req, room, boxSessionId) {
    if (typeof boxSessionId !== 'string' || !boxSessionId) return { ok: false, error: 'TRIAL_EVIDENCE_REF_INVALID', message: 'boxSessionId must be a session id.' };
    const s = (db.boxSessions ?? []).find((x) => x && x.id === boxSessionId) ?? null;
    if (!s || s.playerId !== room.playerId) return { ok: false, error: 'TRIAL_BOXCAM_INCOMPATIBLE', message: 'No Box Cam session of this player with that id is available to your organisation.' };
    const provider = PROVIDERS[s.provider];
    if (provider?.testOnly && !testProviderEnabled) return { ok: false, error: 'TRIAL_BOXCAM_INCOMPATIBLE', message: 'No Box Cam session of this player with that id is available to your organisation.' };
    const player = findPlayer(room.playerId);
    if (!player || !orgCanSee(req.org, player)) return { ok: false, error: 'TRIAL_BOXCAM_INCOMPATIBLE', message: 'No Box Cam session of this player with that id is available to your organisation.' };
    // The Combine consent rule, reused unchanged: the player's recruitment
    // opt-in or an active Combine request from this organisation. A trial is
    // not consent to the player's home footage.
    if (!combineOrgMaySeeResults?.(req.org, player)) return { ok: false, error: 'EVIDENCE_CONSENT_REQUIRED', message: 'This player has not shared Box Cam activity with your organisation.' };
    if (['cancelled', 'invalidated'].includes(s.verificationState) || s.status === 'cancelled') return { ok: false, error: 'EVIDENCE_WITHDRAWN', message: 'This Box Cam session was withdrawn or invalidated and cannot be cited.' };
    if (!s.finalizedAt) return { ok: false, error: 'EVIDENCE_NOT_FINAL', message: 'This Box Cam session has not finished; only a finalised session can be cited.' };
    return { ok: true, session: s };
  }

  orgRouter.post('/rooms/:id/trials/:tid/sessions/:sid/evidence', (req, res) => {
    const got = roomFor(req, res, 'trial_write');
    if (!got) return;
    const { room } = got;
    const t = findTrial(req, res, room);
    if (!t) return;
    const at = now(req);
    const key = normaliseTrialClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const boxSessionId = req.body?.boxSessionId;
    const fp = payloadFingerprint({ trialSessionId: req.params.sid, boxSessionId: typeof boxSessionId === 'string' ? boxSessionId : null });
    const kc = keyCheck(t, 'link', key.key, fp);
    if (kc.conflict) return err(res, 'TRIAL_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different evidence link.');
    if (kc.replay) return res.json({ trial: trialClubView(t), evidence: evidenceViews(t), idempotent: true });
    const auth = reauth(req, res, room, t, 'link');
    if (!auth) return;
    const s = findSession(res, t, req.params.sid);
    if (!s) return;
    const la = linkAuthorisation(req, room, boxSessionId);
    if (!la.ok) return err(res, la.error, la.message);
    if (!revGate(req, res, t)) return;
    // Idempotent on (trialSessionId, boxSessionId): linking twice is a replay (D-12).
    s.evidence ??= [];
    const existing = s.evidence.find((e) => e.kind === 'box_cam_session' && e.sessionId === la.session.id && !e.removedAt);
    if (existing) return res.json({ trial: trialClubView(t), evidence: evidenceViews(t), idempotent: true });
    if (s.evidence.filter((e) => !e.removedAt).length >= TRIAL_LIMITS.evidencePerSession) return err(res, 'TRIAL_INVALID_STATE', `A session cites at most ${TRIAL_LIMITS.evidencePerSession} Box Cam sessions.`);
    if (limited('trial_evidence_link', req.org.id)) return res.status(429).json(rateLimitedBody('trial_evidence_link'));
    const by = orgActor(req);
    // Reference only (N1/N5): the session id and the link event. Nothing is
    // copied; provenance is read live at projection time.
    s.evidence.push({ id: nextId('tev'), kind: 'box_cam_session', sessionId: la.session.id, linkedAt: at, linkedBy: by, removedAt: null, removedBy: null });
    record(t, 'trial_evidence_linked', by, { trialSessionId: s.id, kind: 'box_cam_session', sessionId: la.session.id }, at);
    keyRecord(t, 'link', key.key, fp, at);
    bumpRev(t, { by: req.orgUser, at });
    persistNow();
    broadcast('trial_evidence_linked', { orgId: room.orgId, roomId: room.id, trialId: t.id, sessionId: s.id });
    res.status(201).json({ trial: trialClubView(t), evidence: evidenceViews(t) });
  });

  orgRouter.post('/rooms/:id/trials/:tid/evidence/:eid/unlink', (req, res) => {
    const got = roomFor(req, res, 'trial_write');
    if (!got) return;
    const { room } = got;
    const t = findTrial(req, res, room);
    if (!t) return;
    const at = now(req);
    const auth = reauth(req, res, room, t, 'link');
    if (!auth) return;
    let hit = null; let sess = null;
    for (const s of t.schedule?.sessions ?? []) { const e = (s.evidence ?? []).find((x) => x.id === req.params.eid); if (e) { hit = e; sess = s; break; } }
    if (!hit) return err(res, 'TRIAL_SESSION_NOT_FOUND', 'No such evidence link on this trial.');
    if (!revGate(req, res, t)) return;
    if (hit.removedAt) return res.json({ trial: trialClubView(t), evidence: evidenceViews(t), idempotent: true });
    // Tombstoned, never erased: the link row stays with its removal time.
    hit.removedAt = at;
    hit.removedBy = orgActor(req);
    record(t, 'trial_evidence_unlinked', orgActor(req), { trialSessionId: sess.id, sessionId: hit.sessionId }, at);
    bumpRev(t, { by: req.orgUser, at });
    persistNow();
    res.json({ trial: trialClubView(t), evidence: evidenceViews(t) });
  });

  orgRouter.get('/rooms/:id/trials/:tid/evidence', (req, res) => {
    const got = roomFor(req, res, 'trial_view');
    if (!got) return;
    const t = findTrial(req, res, got.room);
    if (!t) return;
    res.json({ items: evidenceViews(t), note: 'Machine observation, referenced live from the player\'s own Box Cam record. A refusal means no reliable observation is available; it is never a statement about the player.' });
  });

  /**
   * `trialEvidenceView` (classification N3/N4/N5). Read live from the source;
   * never `trace[]`, `nonce`, `obs.*`, frames, or a numeric confidence. A
   * refusal is projected with the existing player-facing sentence under a
   * neutral state; an invalidated session projects as withdrawn; a session
   * that no longer exists projects as unavailable. The link row is history
   * either way.
   */
  function evidenceViews(t) {
    const out = [];
    for (const s of (t.schedule?.sessions ?? []).slice().sort(byStartsAtThenId)) {
      for (const e of s.evidence ?? []) out.push(trialEvidenceView(t, s, e));
    }
    return out;
  }
  function trialEvidenceView(t, s, e) {
    const base = { id: e.id, kind: e.kind, trialSessionId: s.id, linkedAt: e.linkedAt, linkedBy: { name: e.linkedBy?.name ?? null }, removedAt: e.removedAt ?? null, provenance: 'box_cam_observed', combineVerified: false, combineVerifiedBlockedBy: COMBINE_DISABLED_REASON.code };
    const bs = (db.boxSessions ?? []).find((x) => x && x.id === e.sessionId && x.playerId === t.playerId) ?? null;
    if (!bs) return { ...base, session: null, observation: { state: 'unavailable', copy: 'This Box Cam session is no longer available.', qualityState: null, experimental: null }, providerVersion: null, engineVersion: null, cvPolicyVersion: null };
    const invalidated = bs.verificationState === 'invalidated' || bs.status === 'cancelled' || bs.verificationState === 'cancelled';
    const session = { id: bs.id, drillId: bs.drillId ?? null, protocolId: bs.protocolId ?? null, capturedAt: bs.endedAt ?? bs.startedAt ?? bs.createdAt ?? null, verificationState: bs.verificationState ?? null, simulated: !!PROVIDERS[bs.provider]?.testOnly, invalidated };
    if (invalidated) return { ...base, session, observation: { state: 'evidence_withdrawn', copy: 'This Box Cam session was withdrawn after review; no observation is available.', qualityState: null, experimental: null }, providerVersion: bs.providerVersion ?? null, engineVersion: null, cvPolicyVersion: null };
    const cv = (db.boxCamCvResults ?? []).find((r) => r && r.boxCamSessionId === bs.id) ?? null;
    let observation;
    if (!cv) {
      observation = { state: 'no_cv_result', copy: 'No reliable observation available for this session.', qualityState: null, experimental: null };
    } else if (cv.outcome === 'accepted') {
      observation = { state: 'accepted', copy: 'This session was observed by Box Cam.', qualityState: cv.observationQuality?.state ?? null, experimental: cv.experimental ? { status: cv.experimental.status ?? 'experimental_unvalidated' } : null };
    } else {
      const reason = cv.refusalReason ?? 'unknown';
      observation = { state: reason, copy: `No reliable observation available. ${CV_STATE_COPY[reason] ?? ''}`.trim(), qualityState: cv.observationQuality?.state ?? null, experimental: null };
    }
    return { ...base, session, observation, providerVersion: cv?.providerVersion ?? bs.providerVersion ?? null, engineVersion: cv?.engineVersion ?? null, cvPolicyVersion: cv?.cvPolicyVersion ?? null };
  }
  ctx.trialEvidenceViews = evidenceViews;

  // --------------------------------------------------------------- hooks

  /**
   * Called by the existing respond routes BEFORE an acceptance of a
   * case-tied Trial invitation is recorded (D-7): the recipient is
   * re-derived now and must be the person answering. Also the failure
   * injection point for acceptance — refused here, nothing is written.
   */
  ctx.trialAcceptGate = ({ request, by, actorId }) => {
    const room = (db.recruitmentCases ?? []).find((k) => k?.id === request.caseId) ?? null;
    const org = orgOf(request.orgId);
    const fail = (error, message) => ({ ok: false, status: httpStatusFor(error) ?? 422, error, message });
    if (!room || !org) return fail('TRIAL_RECIPIENT_UNAVAILABLE', 'This invitation can no longer be accepted.');
    const r = recipientFor(org, request.playerId);
    if (!r.ok) return fail(r.error, r.message);
    if (r.recipient.type !== by) return fail('TRIAL_RECIPIENT_UNAVAILABLE', by === 'guardian' ? 'This player is now the recipient of their own trial invitations; the club needs to re-invite.' : 'This invitation is managed by the player\'s guardian.');
    if (by === 'guardian' && r.recipient.guardianId !== actorId) return fail('TRIAL_GUARDIAN_REQUIRED', 'You are no longer the verified guardian route for this player.');
    if (by === 'player' && r.recipient.playerId !== actorId) return fail('TRIAL_RECIPIENT_UNAVAILABLE', 'This invitation is not yours to accept.');
    const inject = db.deliveryFailInject;
    if (inject && Number(inject.trial ?? 0) > 0) {
      inject.trial = Number(inject.trial) - 1;
      persistNow();
      return fail('TRIAL_TRANSPORT_REFUSED', 'The acceptance could not be recorded. Nothing was changed; try again.');
    }
    return { ok: true };
  };

  /** After the single writer created the trial row: link it to the case and, if the slot was concrete, confirm the case's trial_scheduled. Same save as the answer. */
  ctx.onTrialAccepted = ({ request, trial, at, actor }) => {
    request.trialId = trial.id;
    const room = (db.recruitmentCases ?? []).find((k) => k?.id === request.caseId) ?? null;
    if (!room) return null;
    room.links ??= { requestIds: [], trialIds: [], signingId: null };
    if (!room.links.trialIds.includes(trial.id)) room.links.trialIds.push(trial.id);
    audit(room, actor.kind, actor.id, actor.name, 'room_trial_accepted', { trialId: trial.id, requestId: request.id, recipientType: actor.kind, scheduled: trial.workflowState === 'scheduled' });
    let moved = { applied: false, reason: 'not_scheduled', at };
    if (trial.workflowState === 'scheduled') {
      moved = advanceCase({ room, action: 'confirmTrial', at, trigger: `trial:accept:${trial.id}`, actor, keyDetail: { trialId: trial.id } });
    }
    trial.lifecycle = moved;
    for (const uid of new Set([room.ownerUserId, room.room?.leadScoutUserId])) {
      if (!uid || uid === request.userId) continue;
      notify({ kind: 'org_user', id: uid }, 'trial_day', `Recruitment Room — ${room.playerName ?? 'a removed player'}: the ${actor.kind} accepted the trial invitation${trial.workflowState === 'scheduled' ? ' and confirmed the schedule' : ''}.`, trial.id);
    }
    broadcast('trial_accepted', { orgId: room.orgId, roomId: room.id, trialId: trial.id, requestId: request.id });
    return moved;
  };

  ctx.onTrialDeclined = ({ request, at, actor }) => {
    const room = (db.recruitmentCases ?? []).find((k) => k?.id === request.caseId) ?? null;
    if (!room) return null;
    audit(room, actor.kind, actor.id, actor.name, 'room_trial_declined', { requestId: request.id, recipientType: actor.kind });
    for (const uid of new Set([room.ownerUserId, room.room?.leadScoutUserId])) {
      if (!uid || uid === request.userId) continue;
      notify({ kind: 'org_user', id: uid }, 'trial_day', `Recruitment Room — ${room.playerName ?? 'a removed player'}: the ${actor.kind} declined the trial invitation.`, request.id);
    }
    broadcast('trial_declined', { orgId: room.orgId, roomId: room.id, requestId: request.id });
    void at;
    return true;
  };

  // ------------------------------------------------------- recipient routes

  /** The trial for this recipient, and the recipient re-derived now (D-7). */
  function recipientTrial(req, res, { by, actorId, playerIds }) {
    if (!storeOr500(res)) return null;
    const t = db.trials.find((x) => x && x.id === req.params.id && playerIds.includes(x.playerId)) ?? null;
    if (!t) { err(res, 'TRIAL_NOT_FOUND', 'No such trial.'); return null; }
    if (t.subjectRemovedAt) { err(res, 'TRIAL_SUBJECT_REMOVED', 'This trial can no longer be changed.'); return null; }
    const org = orgOf(t.orgId);
    const r = resolveContactRecipient({ player: findPlayer(t.playerId), org: org ?? { id: t.orgId }, guardians: db.guardians ?? [], isAdult, visibleToOrg, isBlocked, now: new Date() });
    // A blocked organisation cannot be confirmed with — but the recipient may
    // still cancel (the decline path). The caller decides which.
    const blocked = !r.ok && r.error === 'CONTACT_BLOCKED';
    if (!r.ok && !blocked) { err(res, RECIPIENT_CODES[r.error] ?? 'TRIAL_RECIPIENT_UNAVAILABLE', by === 'guardian' ? 'You are no longer the verified guardian route for this player.' : 'This trial is not yours to act on.'); return null; }
    if (!blocked && r.recipient.type !== by) { err(res, 'TRIAL_RECIPIENT_UNAVAILABLE', by === 'guardian' ? 'This player now manages their own trials.' : 'This trial is managed by your parent or guardian.'); return null; }
    if (!blocked && by === 'guardian' && r.recipient.guardianId !== actorId) { err(res, 'TRIAL_GUARDIAN_REQUIRED', 'You are no longer the verified guardian route for this player.'); return null; }
    return { trial: t, blocked };
  }

  function confirmHandler(by) {
    return (req, res) => {
      if (by === 'player' && guardianManagedOnly(req, res)) return;
      const actorId = by === 'guardian' ? req.guardian.id : req.player.id;
      const actorName = by === 'guardian' ? req.guardian.name : req.player.name;
      const playerIds = by === 'guardian' ? req.guardian.childIds : [req.player.id];
      const got = recipientTrial(req, res, { by, actorId, playerIds });
      if (!got) return;
      const { trial: t, blocked } = got;
      if (blocked) return err(res, 'TRIAL_BLOCKED', 'You have blocked this organisation. Lift the block before confirming a trial with it.');
      const at = now(req);
      if (!t.schedule) return err(res, 'TRIAL_INVALID_STATE', 'There is no schedule to confirm yet.');
      if (['completed', 'cancelled'].includes(deriveWorkflowState(t))) return err(res, 'TRIAL_INVALID_STATE', 'This trial has ended.');
      if (t.schedule.confirmedAt) return res.json({ trial: trialFamilyView(t), idempotent: true });
      if (limited('trial_response', `${by}:${actorId}`)) return res.status(429).json(rateLimitedBody('trial_response'));
      if (expectedRevOf(req.body) !== null) {
        const rawRev = req.body?.expectedRev ?? req.body?.expectedVersion;
        if (!Number.isInteger(rawRev) || rawRev < 0) return err(res, 'TRIAL_REV_REQUIRED', 'expectedRev must be a non-negative integer.', { field: 'expectedRev', expected: 'integer' });
        if (!guardRev(req, res, t, { errorCode: 'TRIAL_VERSION_CONFLICT', current: { workflowState: deriveWorkflowState(t) } })) return;
      }
      const who = { kind: by, id: actorId, name: actorName };
      t.schedule.confirmedAt = at;
      t.schedule.confirmedBy = who;
      t.schedule.declinedAt = null;
      const rev = t.schedule.revisions.find((r) => r.revision === t.schedule.revision);
      if (rev) { rev.confirmedAt = at; rev.confirmedBy = who; }
      t.workflowState = deriveWorkflowState(t);
      t.recipient = { type: by, playerId: t.playerId, guardianId: by === 'guardian' ? actorId : null, minor: by === 'guardian', at };
      record(t, 'trial_schedule_confirmed', who, { revision: t.schedule.revision, sessionCount: t.schedule.sessions.length }, at);
      bumpRev(t, { by: null, at });
      let moved = { applied: false, reason: 'legacy_no_case', at };
      const room = t.caseId ? (db.recruitmentCases ?? []).find((k) => k?.id === t.caseId) ?? null : null;
      if (room) moved = advanceCase({ room, action: 'confirmTrial', at, trigger: `trial:confirm:${t.id}`, actor: who, keyDetail: { trialId: t.id } });
      t.lifecycle = moved;
      persistNow();
      if (room) broadcast('trial_scheduled', { orgId: room.orgId, roomId: room.id, trialId: t.id });
      notifyClub(t, `${actorName} confirmed the trial schedule for ${t.playerName ?? 'the player'} (revision ${t.schedule.revision}).`);
      res.json({ trial: trialFamilyView(t) });
    };
  }

  function declineScheduleHandler(by) {
    return (req, res) => {
      if (by === 'player' && guardianManagedOnly(req, res)) return;
      const actorId = by === 'guardian' ? req.guardian.id : req.player.id;
      const actorName = by === 'guardian' ? req.guardian.name : req.player.name;
      const playerIds = by === 'guardian' ? req.guardian.childIds : [req.player.id];
      const got = recipientTrial(req, res, { by, actorId, playerIds });
      if (!got) return;
      const { trial: t } = got;
      const at = now(req);
      if (!t.schedule || t.schedule.confirmedAt) return err(res, 'TRIAL_INVALID_STATE', 'There is no proposed schedule awaiting your answer.');
      if (['completed', 'cancelled'].includes(deriveWorkflowState(t))) return err(res, 'TRIAL_INVALID_STATE', 'This trial has ended.');
      if (t.schedule.declinedAt) return res.json({ trial: trialFamilyView(t), idempotent: true });
      if (limited('trial_response', `${by}:${actorId}`)) return res.status(429).json(rateLimitedBody('trial_response'));
      const reasonRaw = req.body?.reason;
      if (reasonRaw !== undefined && reasonRaw !== null && (typeof reasonRaw !== 'string' || reasonRaw.length > TRIAL_LIMITS.reason)) return err(res, 'TRIAL_CONTENT_INVALID', `A reason is text under ${TRIAL_LIMITS.reason} characters.`, { field: 'reason' });
      const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : null;
      if (reason && !moderateOrRefuse(res, reason, { kind: 'trial_schedule_decline', trialId: t.id })) return;
      const who = { kind: by, id: actorId, name: actorName };
      t.schedule.declinedAt = at;
      t.schedule.declinedBy = who;
      record(t, 'trial_schedule_declined', who, { revision: t.schedule.revision, hadReason: !!reason }, at);
      bumpRev(t, { by: null, at });
      persistNow();
      notifyClub(t, `${actorName} declined the proposed trial schedule for ${t.playerName ?? 'the player'} (revision ${t.schedule.revision})${reason ? `: ${reason}` : '.'}`);
      res.json({ trial: trialFamilyView(t) });
    };
  }

  function recipientCancelHandler(by) {
    return (req, res) => {
      if (by === 'player' && guardianManagedOnly(req, res)) return;
      const actorId = by === 'guardian' ? req.guardian.id : req.player.id;
      const actorName = by === 'guardian' ? req.guardian.name : req.player.name;
      const playerIds = by === 'guardian' ? req.guardian.childIds : [req.player.id];
      const got = recipientTrial(req, res, { by, actorId, playerIds });
      if (!got) return;
      const { trial: t } = got;
      const at = now(req);
      const state = deriveWorkflowState(t);
      if (['completed', 'cancelled'].includes(state)) return res.json({ trial: trialFamilyView(t), idempotent: state === 'cancelled' });
      if (limited('trial_response', `${by}:${actorId}`)) return res.status(429).json(rateLimitedBody('trial_response'));
      const reasonRaw = req.body?.reason;
      if (reasonRaw !== undefined && reasonRaw !== null && (typeof reasonRaw !== 'string' || reasonRaw.length > TRIAL_LIMITS.reason)) return err(res, 'TRIAL_CONTENT_INVALID', `A reason is text under ${TRIAL_LIMITS.reason} characters.`, { field: 'reason' });
      const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : null;
      if (reason && !moderateOrRefuse(res, reason, { kind: 'trial_cancellation', trialId: t.id })) return;
      const who = { kind: by, id: actorId, name: actorName };
      t.completion = { state: 'cancelled', at, by: who, reason, phase: state, cancelledBy: by };
      t.workflowState = 'cancelled';
      record(t, 'trial_cancelled', who, { phase: state, cancelledBy: by, attendedSessions: [...currentAttendance(t).values()].filter((a) => ['attended', 'partial'].includes(a.state)).length }, at);
      bumpRev(t, { by: null, at });
      persistNow();
      const room = t.caseId ? (db.recruitmentCases ?? []).find((k) => k?.id === t.caseId) ?? null : null;
      if (room) broadcast('trial_cancelled', { orgId: room.orgId, roomId: room.id, trialId: t.id });
      notifyClub(t, `${actorName} cancelled the trial for ${t.playerName ?? 'the player'}${reason ? `: ${reason}` : '.'}`);
      res.json({ trial: trialFamilyView(t) });
    };
  }

  playerRouter.post('/trials/:id/confirm-schedule', confirmHandler('player'));
  guardianRouter.post('/trials/:id/confirm-schedule', confirmHandler('guardian'));
  playerRouter.post('/trials/:id/decline-schedule', declineScheduleHandler('player'));
  guardianRouter.post('/trials/:id/decline-schedule', declineScheduleHandler('guardian'));
  playerRouter.post('/trials/:id/cancel', recipientCancelHandler('player'));
  guardianRouter.post('/trials/:id/cancel', recipientCancelHandler('guardian'));

  // ---------------------------------------------------------- vocabulary

  orgRouter.get('/recruitment/trial-policy', (_req, res) => {
    res.json({
      policyVersion: TRIAL_POLICY_VERSION,
      workflowStates: TRIAL_WORKFLOW_STATES,
      sessionKinds: TRIAL_SESSION_KINDS,
      attendanceStates: TRIAL_ATTENDANCE_STATES,
      cancelActors: TRIAL_CANCEL_ACTORS,
      caseStatuses: TRIAL_CASE_STATUSES,
      limits: TRIAL_LIMITS,
      note: 'An invitation is not a trial; acceptance is not a schedule; a schedule is not attendance; attendance is not completion; completion is not an assessment; an assessment is not a decision. Box Cam observation is machine evidence, never an assessment; a refusal means no reliable observation, never poor performance.',
    });
  });

  return { trialsOf, evidenceViews, trialEvidenceView, TRIAL_CASE_STATUSES };
}

/** Exported for the evidence-side unit tests: the slot chooser the respond routes use. */
export { chooseTrialSlot, parseInstant };
