/**
 * M23 P3 — Contact routes: the club side of one communication process.
 *
 *   GET   /org/rooms/:id/contacts                 history + live routing preview
 *   POST  /org/rooms/:id/contacts                 create a DRAFT (nothing leaves)
 *   GET   /org/rooms/:id/contacts/:cid
 *   PATCH /org/rooms/:id/contacts/:cid            edit a draft (expectedRev required)
 *   POST  /org/rooms/:id/contacts/:cid/send       hand it to the in-app transport
 *   POST  /org/rooms/:id/contacts/:cid/cancel     withdraw a draft
 *   POST  /org/rooms/:id/contacts/external        attest a contact made outside ScoutBox
 *
 * There is deliberately NO recipient route in this file. The recipient sees
 * the `db.requests` row the send creates, through the Inbox that already
 * exists, and answers through the respond route that already exists; that
 * route calls `ctx.onRequestResponded` (registered here) so the answer lands
 * on the Contact. One Inbox, one response path, one channel-opening path.
 *
 * WHAT A SEND IS
 *
 * All mutations of one send — the request row, the Contact, the case's
 * lifecycle entry — happen synchronously in one handler with no await
 * between them, and are written by ONE `persistNow()`. The snapshot store
 * saves in one SQLite transaction, so the disk either holds all of them or
 * none. The case cannot say `contacted` on disk while the Contact that
 * justifies it was lost.
 */

import { visibleToOrg } from '../domain.mjs';
import { roomRole, ROOM_STATUS_LABELS } from '../m17/shared.mjs';
import { guardRev, bumpRev, expectedRevOf } from '../m181/concurrency.mjs';
import { rateLimitedBody } from '../m181/rateLimit.mjs';
import { canTransitionRecruitmentCase, RECRUITMENT_LIFECYCLE_POLICY_VERSION } from './lifecycle.mjs';
import { sendDomainError } from './errors.mjs';
import {
  CONTACT_POLICY_VERSION, CONTACT_LIMITS, CONTACT_CHANNELS, EXTERNAL_CHANNELS, CONTACT_STATUSES,
  CONTACT_CASE_STATUSES, canContactAction, contactRoleAllows, validateContactContent,
  normaliseClientKey, resolveContactRecipient, validateExternalRecord, cooldownFor,
  payloadFingerprint, contactView, contactIntegrity, caseAcceptsContact, byAtThenId,
} from './contact.mjs';

export function registerContact(ctx) {
  const {
    db, orgRouter, nextId, persistNow, notify, broadcast, findPlayer, isBlocked, isAdult,
    rateLimit, mailer, isLead, moderateOrRefuse, issueRecruitmentRequest,
  } = ctx;

  const now = () => Date.now();
  const store = () => (Array.isArray(db.recruitmentContacts) ? db.recruitmentContacts : null);
  const actorOf = (req) => ({ kind: 'org', userId: req.orgUser.id, name: req.orgUser.name });
  const roleFor = (req, room) => roomRole({ room, user: req.orgUser, isLead: isLead(req.orgUser) });
  const limited = (action, keyPart) => !!rateLimit?.limited(action, keyPart);
  const err = (res, error, message, extra = {}) => sendDomainError(res, { error, message, ...extra }, 'contact');

  /** One history entry, ONE clock: the caller passes the moment the event happened. */
  const record = (c, action, by, detail, at) => {
    c.history ??= [];
    c.history.push({ id: nextId('aud'), at, action, by, detail: detail ?? null });
  };

  // ------------------------------------------------------------- lookups

  /** The room, through M17's concealing lookup, plus the caller's live role and the permission check. */
  function roomFor(req, res, need) {
    const room = ctx.findRoomForRequest(req, res);
    if (!room) return null;
    const role = roleFor(req, room);
    if (!contactRoleAllows(role, need)) {
      err(res, 'CONTACT_NOT_PERMITTED', need === 'contact_write'
        ? 'Only a room lead or recruitment lead can draft, send or record a contact.'
        : 'Your role cannot read contacts in this room.');
      return null;
    }
    return { room, role };
  }

  function storeOr500(res) {
    const s = store();
    if (!s) {
      console.error('CONTACT store_missing db.recruitmentContacts is absent or not a list');
      err(res, 'CONTACT_STORE_MISSING', 'Contacts cannot be served right now.');
    }
    return s;
  }

  /** This case's contacts, corrupt records excluded and named in the log. */
  function contactsOf(room) {
    const s = store() ?? [];
    const good = [];
    let omitted = 0;
    for (const c of s) {
      if (!c || c.caseId !== room.id || c.orgId !== room.orgId) continue;
      const problems = contactIntegrity(c, { orgId: room.orgId, caseId: room.id });
      if (problems.length) { omitted += 1; console.error(`CONTACT integrity ${c.id ?? '?'}: ${problems.join(',')}`); continue; }
      good.push(c);
    }
    good.sort((a, b) => (a.createdAt - b.createdAt) || String(a.id).localeCompare(String(b.id)));
    return { list: good, omitted };
  }

  function findContact(req, res, room) {
    const s = storeOr500(res);
    if (!s) return null;
    const c = s.find((x) => x && x.id === req.params.cid && x.caseId === room.id && x.orgId === room.orgId);
    if (!c) { err(res, 'CONTACT_NOT_FOUND', 'No such contact.'); return null; }
    const problems = contactIntegrity(c, { orgId: room.orgId, caseId: room.id });
    if (problems.length) {
      console.error(`CONTACT integrity ${c.id}: ${problems.join(',')}`);
      err(res, 'CONTACT_STATE_UNKNOWN', 'This contact cannot be read.');
      return null;
    }
    return c;
  }

  /** The live answer to "who would this reach?", computed now, never trusted from a client. */
  const recipientFor = (req, room) => resolveContactRecipient({
    player: findPlayer(room.playerId), org: req.org, guardians: db.guardians ?? [],
    isAdult, visibleToOrg, isBlocked, now: new Date(),
  });

  const routingView = (r) => (r.ok
    ? { available: true, type: r.recipient.type, minor: r.recipient.minor }
    : { available: false, type: null, minor: null, reason: r.error });

  /** The case must have AGREED to approach the player (contact_planned) or already have done so. */
  function caseGate(res, room) {
    if (caseAcceptsContact(room.room?.status)) return true;
    err(res, 'CONTACT_CASE_STATE', `A case at "${ROOM_STATUS_LABELS[room.room?.status] ?? room.room?.status}" cannot contact the player. Plan the contact first (planContact).`, { allowed: CONTACT_CASE_STATUSES });
    return false;
  }

  /** `expectedRev` is REQUIRED on a mutation of an existing Contact; absent is refused, never coerced. */
  function revGate(req, res, c) {
    const exp = expectedRevOf(req.body);
    if (exp === null) { err(res, 'CONTACT_REV_REQUIRED', 'expectedRev is required: send the rev you were editing.'); return false; }
    return guardRev(req, res, c, { errorCode: 'CONTACT_VERSION_CONFLICT', current: { status: c.status } });
  }

  /**
   * The lifecycle coupling (§30–§31). The Contact does not write a case
   * status. It asks the ONE validator whether `recordContact` is possible —
   * with the real evidence provider, which now sees this Contact — and, if
   * so, writes through the ONE status writer. "Already contacted" is
   * recorded on the Contact and is not an error (contract §8).
   */
  function advanceCase(req, room, c, at) {
    const role = roleFor(req, room);
    const verdict = canTransitionRecruitmentCase(room, 'recordContact', { role, evidence: ctx.recruitmentEvidenceProvider, now: at });
    if (verdict.ok) {
      const { from, to } = ctx.applyLifecycleTransition({ req, room, to: verdict.to, reasonCodes: [], trigger: `contact:${c.id}` });
      const last = room.history[room.history.length - 1];
      if (last?.action === 'room_status_changed') {
        last.detail = { ...last.detail, lifecycleAction: 'recordContact', clientKey: null, policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION, contactId: c.id };
      }
      c.lifecycle = { applied: true, from, to, at };
      return { from, to };
    }
    // LIFECYCLE_NO_CHANGE (already contacted) is the expected second answer.
    // Anything else is recorded so the mismatch is visible, never hidden.
    c.lifecycle = { applied: false, reason: verdict.error, at };
    if (verdict.error !== 'LIFECYCLE_NO_CHANGE') console.error(`CONTACT lifecycle_not_applied ${c.id} ${verdict.error}`);
    return null;
  }

  // ---------------------------------------------------------------- list

  orgRouter.get('/rooms/:id/contacts', (req, res) => {
    const got = roomFor(req, res, 'contact_view');
    if (!got) return;
    if (!storeOr500(res)) return;
    const { room, role } = got;
    const { list, omitted } = contactsOf(room);
    const routing = recipientFor(req, room);
    const cooldown = cooldownFor(store(), { orgId: room.orgId, playerId: room.playerId, now: now() });
    res.json({
      items: list.map(contactView),
      omitted,
      routing: routingView(routing),
      case: { status: room.room.status, acceptsContact: caseAcceptsContact(room.room.status), planAction: 'planContact' },
      canWrite: contactRoleAllows(role, 'contact_write'),
      cooldown: cooldown ? { until: cooldown.retryAt } : null,
      channels: { inApp: 'in_app', external: EXTERNAL_CHANNELS.map((id) => ({ id, label: CONTACT_CHANNELS[id].label })) },
      limits: { subject: CONTACT_LIMITS.subject, body: CONTACT_LIMITS.body, summary: CONTACT_LIMITS.summary, replyMessage: CONTACT_LIMITS.replyMessage },
      policyVersion: CONTACT_POLICY_VERSION,
      note: 'A draft is internal to your organisation. Only a sent message or a recorded external contact is a contact.',
    });
  });

  orgRouter.get('/rooms/:id/contacts/:cid', (req, res) => {
    const got = roomFor(req, res, 'contact_view');
    if (!got) return;
    const c = findContact(req, res, got.room);
    if (!c) return;
    res.json({ contact: contactView(c) });
  });

  // ---------------------------------------------------------------- draft

  orgRouter.post('/rooms/:id/contacts', (req, res) => {
    const got = roomFor(req, res, 'contact_write');
    if (!got) return;
    const { room } = got;
    const s = storeOr500(res);
    if (!s) return;

    const key = normaliseClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const content = validateContactContent(req.body ?? {});
    if (!content.ok) return err(res, content.error, content.message);
    const fp = payloadFingerprint({ subject: content.subject, body: content.body });

    // Replay of the same create: the same Contact, not a second one.
    if (key.key) {
      const prior = contactsOf(room).list.find((c) => c.keys?.create?.key === key.key);
      if (prior && prior.keys.create.fp === fp) return res.json({ contact: contactView(prior), idempotent: true });
      if (prior) return err(res, 'CONTACT_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different draft.');
    }

    if (!caseGate(res, room)) return;
    if (limited('contact_draft', req.org.id)) return res.status(429).json(rateLimitedBody('contact_draft'));

    // A draft for someone the club cannot contact is refused at compose time,
    // and the same rule runs again at send time (§17: block before compose).
    const routing = recipientFor(req, room);
    if (!routing.ok) return err(res, routing.error, routing.message);

    if (!moderateOrRefuse(res, `${content.subject ?? ''}\n${content.body}`, { kind: 'recruitment_contact', orgId: req.org.id, userId: req.orgUser.id })) return;

    const at = now();
    const by = actorOf(req);
    const c = {
      id: nextId('rct'), orgId: room.orgId, caseId: room.id, playerId: room.playerId,
      status: 'draft', channel: 'in_app', recipient: null,
      subject: content.subject, body: content.body, summary: null,
      createdBy: by, createdAt: at, updatedAt: at,
      sentBy: null, sentAt: null, deliveredAt: null, failedAt: null, failureCode: null,
      attempts: [], requestId: null, emailCopy: null, lifecycle: null,
      occurredAt: null, recordedBy: null, recordedAt: null,
      respondedAt: null, response: null, cancelledAt: null, cancelledBy: null,
      keys: { create: key.key ? { key: key.key, fp } : null, send: null, record: null },
      history: [], rev: 0, revAt: at, revBy: null,
      policyVersion: CONTACT_POLICY_VERSION,
    };
    record(c, 'contact_created', by, { channel: 'in_app' }, at);
    bumpRev(c, { by: req.orgUser, at });
    s.push(c);
    // NOTHING ELSE. No case history, no notification, no request row, no
    // outbox entry, no delivery state. A draft is a record of intent.
    persistNow();
    broadcast('contact_created', { orgId: room.orgId, roomId: room.id, contactId: c.id });
    res.status(201).json({ contact: contactView(c), routing: routingView(routing) });
  });

  orgRouter.patch('/rooms/:id/contacts/:cid', (req, res) => {
    const got = roomFor(req, res, 'contact_write');
    if (!got) return;
    const { room, role } = got;
    const c = findContact(req, res, room);
    if (!c) return;
    const verdict = canContactAction(c, 'edit', { role });
    if (!verdict.ok) return err(res, verdict.error, verdict.message);
    if (!revGate(req, res, c)) return;

    const body = req.body ?? {};
    const content = validateContactContent({
      subject: body.subject === undefined ? c.subject : body.subject,
      body: body.body === undefined ? c.body : body.body,
    });
    if (!content.ok) return err(res, content.error, content.message);
    const routing = recipientFor(req, room);
    if (!routing.ok) return err(res, routing.error, routing.message);
    if (!moderateOrRefuse(res, `${content.subject ?? ''}\n${content.body}`, { kind: 'recruitment_contact', orgId: req.org.id, userId: req.orgUser.id })) return;

    const at = now();
    const changed = [];
    if (content.subject !== c.subject) { c.subject = content.subject; changed.push('subject'); }
    if (content.body !== c.body) { c.body = content.body; changed.push('body'); }
    c.updatedAt = at;
    record(c, 'contact_edited', actorOf(req), { fields: changed }, at);
    bumpRev(c, { by: req.orgUser, at });
    persistNow();
    res.json({ contact: contactView(c), routing: routingView(routing) });
  });

  orgRouter.post('/rooms/:id/contacts/:cid/cancel', (req, res) => {
    const got = roomFor(req, res, 'contact_write');
    if (!got) return;
    const { room, role } = got;
    const c = findContact(req, res, room);
    if (!c) return;
    const verdict = canContactAction(c, 'cancel', { role });
    if (!verdict.ok) return err(res, verdict.error, verdict.message);
    if (!revGate(req, res, c)) return;
    const at = now();
    c.status = 'cancelled';
    c.cancelledAt = at;
    c.cancelledBy = actorOf(req);
    c.updatedAt = at;
    // The draft text is KEPT. Cancelling records that nothing was sent; it does
    // not erase what was written (§25).
    record(c, 'contact_cancelled', actorOf(req), null, at);
    bumpRev(c, { by: req.orgUser, at });
    persistNow();
    res.json({ contact: contactView(c) });
  });

  // ----------------------------------------------------------------- send

  orgRouter.post('/rooms/:id/contacts/:cid/send', (req, res) => {
    const got = roomFor(req, res, 'contact_write');
    if (!got) return;
    const { room, role } = got;
    const c = findContact(req, res, room);
    if (!c) return;

    const key = normaliseClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    if (key.key) {
      // A send key is bound to the Contact it first sent. The same key on a
      // different Contact is a different request wearing the same name.
      const holder = contactsOf(room).list.find((x) => x.keys?.send?.key === key.key);
      if (holder && holder.id !== c.id) return err(res, 'CONTACT_IDEMPOTENCY_CONFLICT', 'This clientKey was already used to send a different contact.');
      if (holder && holder.id === c.id) return res.json({ contact: contactView(c), delivered: c.status !== 'failed', idempotent: true });
    }

    // Validation before the rev guard, as the lifecycle route does: a stale
    // rev on an impossible action reports the impossibility.
    const verdict = canContactAction(c, 'send', { role });
    if (!verdict.ok) return err(res, verdict.error, verdict.message);
    if (!caseGate(res, room)) return;
    if (!revGate(req, res, c)) return;
    if (limited('contact_send', req.org.id)) return res.status(429).json(rateLimitedBody('contact_send'));

    // RE-DERIVED NOW (§14, §17, §21): the player's age, the guardian route,
    // the block relation and the visibility wall are read at this moment, not
    // from the draft.
    const routing = recipientFor(req, room);
    if (!routing.ok) return err(res, routing.error, routing.message);
    const recipient = routing.recipient;
    const player = findPlayer(room.playerId);

    const cooldown = cooldownFor(store(), { orgId: room.orgId, playerId: room.playerId, now: now(), exceptId: c.id });
    if (cooldown) return err(res, 'CONTACT_COOLDOWN', 'A contact was delivered to this player recently and has not been answered yet. Wait before sending another.', { retryAt: cooldown.retryAt });

    const content = validateContactContent({ subject: c.subject, body: c.body });
    if (!content.ok) return err(res, content.error, content.message);
    if (!moderateOrRefuse(res, `${c.subject ?? ''}\n${c.body}`, { kind: 'recruitment_contact', orgId: req.org.id, userId: req.orgUser.id })) return;

    const at = now();
    const by = actorOf(req);
    c.keys.send = { key: key.key ?? null, fp: payloadFingerprint({ contactId: c.id }) };

    // ---- the transport. The in-app Inbox is the transport of record: the
    // request row is the message in the recipient's mailbox. A refusal here
    // (injected for tests, or a real persistence problem surfaced by the
    // caller) leaves an honest `failed` attempt and no recipient object.
    const inject = db.deliveryFailInject;
    if (inject && Number(inject.contact ?? 0) > 0) {
      inject.contact = Number(inject.contact) - 1;
      c.status = 'failed';
      c.failedAt = at;
      c.failureCode = 'TRANSPORT_REFUSED';
      c.attempts.push({ at, ok: false, code: 'TRANSPORT_REFUSED' });
      c.updatedAt = at;
      record(c, 'contact_send_failed', by, { code: 'TRANSPORT_REFUSED', attempt: c.attempts.length }, at);
      bumpRev(c, { by: req.orgUser, at });
      persistNow();
      console.error(`CONTACT transport_failed ${c.id} attempt=${c.attempts.length}`);
      broadcast('contact_failed', { orgId: room.orgId, roomId: room.id, contactId: c.id });
      return res.json({ contact: contactView(c), delivered: false });
    }

    const request = issueRecruitmentRequest({
      org: req.org, orgUser: req.orgUser, player, type: 'contact',
      message: c.body, subject: c.subject, contactId: c.id,
      guardianId: recipient.guardianId, at,
    }, { persist: false });

    c.status = 'delivered';
    c.recipient = recipient;
    c.requestId = request.id;
    c.sentBy = by;
    c.sentAt = at;
    c.deliveredAt = at;
    c.failedAt = null;
    c.failureCode = null;
    c.attempts.push({ at, ok: true, code: null });
    c.updatedAt = at;
    record(c, 'contact_sent', by, { channel: 'in_app', recipientType: recipient.type, attempt: c.attempts.length }, at);
    bumpRev(c, { by: req.orgUser, at });

    const moved = advanceCase(req, room, c, at);

    // A courtesy email copy to the GUARDIAN only (a player record carries no
    // email). It is a notification that something is waiting in ScoutBox —
    // never the body, never the transport of record, never "delivered".
    c.emailCopy = null;
    let emailJob = null;
    if (recipient.type === 'guardian' && mailer) {
      const g = (db.guardians ?? []).find((x) => x.id === recipient.guardianId);
      if (g?.email) {
        c.emailCopy = { state: 'queued', to: 'guardian', outboxId: null, at };
        emailJob = mailer.send({
          to: g.email,
          subject: `${req.org.name} has sent a message about ${player.name} on ScoutBox`,
          text: `Hi ${g.name},\n\n${req.org.name} (${req.orgUser.role || 'Scout'}: ${req.orgUser.name}) has sent a message about ${player.name} in ScoutBox.\n\nOpen your ScoutBox guardian Inbox to read it and respond. Nothing about this contact happens outside ScoutBox unless you choose to accept it.`,
        });
      } else {
        c.emailCopy = { state: 'not_available', to: 'guardian', outboxId: null, at };
      }
    }

    persistNow();
    broadcast('contact_sent', { orgId: room.orgId, roomId: room.id, contactId: c.id });
    if (emailJob) {
      emailJob.then((rec) => {
        c.emailCopy = { state: mailer.transport === 'dev-outbox' ? 'local_outbox' : (rec?.delivered ? 'accepted_by_provider' : 'failed'), to: 'guardian', outboxId: rec?.id ?? null, at: rec?.ts ?? Date.now() };
        persistNow();
      }).catch(() => {
        c.emailCopy = { state: 'failed', to: 'guardian', outboxId: null, at: Date.now() };
        persistNow();
      });
    }
    res.json({ contact: contactView(c), delivered: true, case: moved ? { from: moved.from, to: moved.to } : { unchanged: true, status: room.room.status } });
  });

  // ------------------------------------------------------- external record

  orgRouter.post('/rooms/:id/contacts/external', (req, res) => {
    const got = roomFor(req, res, 'contact_write');
    if (!got) return;
    const { room } = got;
    const s = storeOr500(res);
    if (!s) return;

    const key = normaliseClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const body = req.body ?? {};
    if (body.recipientType === undefined) return err(res, 'CONTACT_CONTENT_INVALID', 'recipientType is required: who did you speak to, the player or the guardian?');

    // Who the club MAY have spoken to is derived, then compared with what the
    // club says. A minor recorded as "the player" is refused, not corrected.
    const routing = recipientFor(req, room);
    if (!routing.ok) return err(res, routing.error, routing.message);
    const check = validateExternalRecord(body, { now: now(), derivedRecipientType: routing.recipient.type });
    if (!check.ok) return err(res, check.error, check.message, check.allowed ? { allowed: check.allowed } : {});
    const fp = payloadFingerprint({ channel: check.channel, occurredAt: check.occurredAt, summary: check.summary, recipientType: routing.recipient.type });

    if (key.key) {
      const prior = contactsOf(room).list.find((c) => c.keys?.record?.key === key.key);
      if (prior && prior.keys.record.fp === fp) return res.json({ contact: contactView(prior), idempotent: true });
      if (prior) return err(res, 'CONTACT_IDEMPOTENCY_CONFLICT', 'This clientKey was already used to record a different contact.');
    }
    if (!caseGate(res, room)) return;
    if (limited('contact_external_record', req.org.id)) return res.status(429).json(rateLimitedBody('contact_external_record'));
    if (check.summary && !moderateOrRefuse(res, check.summary, { kind: 'recruitment_contact_record', orgId: req.org.id, userId: req.orgUser.id })) return;

    const at = now();
    const by = actorOf(req);
    const c = {
      id: nextId('rct'), orgId: room.orgId, caseId: room.id, playerId: room.playerId,
      status: 'recorded', channel: check.channel, recipient: routing.recipient,
      subject: null, body: null, summary: check.summary,
      createdBy: by, createdAt: at, updatedAt: at,
      sentBy: null, sentAt: null, deliveredAt: null, failedAt: null, failureCode: null,
      attempts: [], requestId: null, emailCopy: null, lifecycle: null,
      occurredAt: check.occurredAt, recordedBy: by, recordedAt: at,
      respondedAt: null, response: null, cancelledAt: null, cancelledBy: null,
      keys: { create: null, send: null, record: key.key ? { key: key.key, fp } : null },
      history: [], rev: 0, revAt: at, revBy: null,
      policyVersion: CONTACT_POLICY_VERSION,
    };
    record(c, 'contact_external_recorded', by, { channel: check.channel, occurredAt: check.occurredAt, recipientType: routing.recipient.type }, at);
    bumpRev(c, { by: req.orgUser, at });
    s.push(c);
    const moved = advanceCase(req, room, c, at);
    persistNow();
    broadcast('contact_external_recorded', { orgId: room.orgId, roomId: room.id, contactId: c.id });
    res.status(201).json({ contact: contactView(c), case: moved ? { from: moved.from, to: moved.to } : { unchanged: true, status: room.room.status } });
  });

  // ------------------------------------------------------------- response

  /**
   * Called by the EXISTING respond routes once a `db.requests` row that a
   * Contact created has been accepted or declined. The recipient never
   * addresses the Contact; the Contact learns of the answer.
   */
  ctx.onRequestResponded = ({ request, accept, message = null, by, at = Date.now() }) => {
    const s = store();
    if (!s || !request?.contactId) return null;
    const c = s.find((x) => x && x.id === request.contactId && x.requestId === request.id);
    if (!c || c.status !== 'delivered') return null;
    const kind = accept ? 'accepted' : 'declined';
    c.status = 'responded';
    c.respondedAt = at;
    c.response = { kind, message: message || null, by, at };
    c.updatedAt = at;
    record(c, 'contact_responded', { kind: by, name: by === 'guardian' ? 'Guardian' : 'Player' }, { kind }, at);
    bumpRev(c, { by: null, at });

    // The sender already hears through the respond route's own notification.
    // The room's owner and lead scout hear too, if they are different people;
    // nobody else in the organisation does (§62).
    const room = (db.recruitmentCases ?? []).find((k) => k?.id === c.caseId);
    if (room) {
      for (const uid of new Set([room.ownerUserId, room.room?.leadScoutUserId])) {
        if (!uid || uid === request.userId) continue;
        notify({ kind: 'org_user', id: uid }, 'recruitment_room', `Recruitment Room — ${room.playerName}: the ${by} ${kind} your contact.`, room.id);
      }
    }
    broadcast('contact_responded', { orgId: c.orgId, roomId: c.caseId, contactId: c.id });
    return c;
  };

  // ---------------------------------------------------------- vocabulary

  orgRouter.get('/recruitment/contact-policy', (_req, res) => {
    res.json({
      policyVersion: CONTACT_POLICY_VERSION,
      statuses: CONTACT_STATUSES,
      channels: Object.keys(CONTACT_CHANNELS).map((id) => ({ id, label: CONTACT_CHANNELS[id].label, external: CONTACT_CHANNELS[id].external })),
      caseStatuses: CONTACT_CASE_STATUSES,
      limits: CONTACT_LIMITS,
      note: 'A draft is not a contact. Delivered means the message is in the recipient\'s ScoutBox Inbox; ScoutBox does not report whether it was read.',
    });
  });

  return { contactsOf, byAtThenId };
}
