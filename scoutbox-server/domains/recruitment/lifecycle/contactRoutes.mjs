/**
 * Contact routes: the club side of one communication process.
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
 * the request row the send creates, through the Inbox that already
 * exists, and answers through the respond route that already exists; that
 * route calls `ctx.onRequestResponded` (registered here) so the answer lands
 * on the Contact. One Inbox, one response path, one channel-opening path.
 *
 * WHAT A SEND IS
 *
 * All mutations of one send — the request row, the Contact, the case's
 * lifecycle entry — happen in ONE unit of work (store.unitOfWork): one SQLite
 * transaction, so the disk either holds all of them or none, and memory is
 * restored if it fails. The case cannot say `contacted` on disk while the
 * Contact that justifies it was lost.
 *
 * A Contact is created whole (`contacts.create`) and then changes only
 * through the repository's named acts (`editDraft`, `cancel`, `recordDelivery`,
 * …), each with the history entries and rev bump it leaves. The records the
 * views hand out are read-only.
 */

import { visibleToOrg } from '../../../domain.mjs';
import { roomRole, ROOM_STATUS_LABELS } from '../rooms/shared.mjs';
import { guardRev, expectedRevOf } from '../../platform/concurrency.mjs';
import { rateLimitedBody } from '../../platform/rateLimit.mjs';
import { canTransitionRecruitmentCase, RECRUITMENT_LIFECYCLE_POLICY_VERSION } from './lifecycle.mjs';
import { sendDomainError } from './errors.mjs';
import {
  CONTACT_POLICY_VERSION, CONTACT_LIMITS, CONTACT_CHANNELS, EXTERNAL_CHANNELS, CONTACT_STATUSES,
  CONTACT_CASE_STATUSES, CONTACT_MODES, canContactAction, contactRoleAllows, validateContactContent,
  normaliseClientKey, resolveContactRecipient, validateExternalRecord, cooldownFor,
  payloadFingerprint, contactView, contactIntegrity, caseAcceptsContact, byAtThenId,
} from './contact.mjs';

export function registerContact(ctx) {
  const {
    guardians, orgRouter, nextId, notify, broadcast, findPlayer, isBlocked, isAdult,
    rateLimit, mailer, isLead, moderateOrRefuse, issueRecruitmentRequest,
    // Every write is an explicit repository operation inside `unit`.
    recruitmentContactsOffers, unit, afterCommit,
    recruitmentReads,
    // The cross-app integration seam: who may be routed a contact besides the player.
    integration,
  } = ctx;

  if (typeof unit !== 'function' || typeof afterCommit !== 'function' || !recruitmentContactsOffers?.contacts) throw new TypeError('registerContact needs the contacts/offers repository, unit and afterCommit from the data layer');
  if (typeof integration?.contactRoute !== 'function' || typeof integration?.contactTargetSnapshot !== 'function') throw new TypeError('registerContact needs the cross-app integration seam (ctx.integration)');
  const contacts = recruitmentContactsOffers.contacts;
  const now = () => Date.now();
  const actorOf = (req) => ({ kind: 'org', userId: req.orgUser.id, name: req.orgUser.name });
  const roleFor = (req, room) => roomRole({ room, user: req.orgUser, isLead: isLead(req.orgUser) });
  const limited = (action, keyPart) => !!rateLimit?.limited(action, keyPart);
  const err = (res, error, message, extra = {}) => sendDomainError(res, { error, message, ...extra }, 'contact');

  /** One history entry, ONE clock: the caller passes the moment the event happened. */
  const entry = (action, by, detail, at) => ({ id: nextId('aud'), at, action, by, detail: detail ?? null });
  /** The bookkeeping of a club user's act on a contact: the history it leaves, the rev bump and the change instant. */
  const byStaff = (req, at, history) => ({ at, revBy: req.orgUser, touch: true, bump: true, history });
  /** A new contact's first rev, stamped by the club user who wrote it. */
  const firstRev = (req, at) => ({ rev: 1, revAt: at, revBy: { userId: req.orgUser.id, name: req.orgUser.name } });

  // ------------------------------------------------------------- lookups

  /** The room, through the rooms' concealing lookup, plus the caller's live role and the permission check. */
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

  /** This case's contacts, corrupt records excluded and named in the log. */
  function contactsOf(room) {
    const good = [];
    let omitted = 0;
    for (const c of contacts.forCase(room.id)) {
      if (c.orgId !== room.orgId) continue;
      const problems = contactIntegrity(c, { orgId: room.orgId, caseId: room.id });
      if (problems.length) { omitted += 1; console.error(`CONTACT integrity ${c.id ?? '?'}: ${problems.join(',')}`); continue; }
      good.push(c);
    }
    good.sort((a, b) => (a.createdAt - b.createdAt) || String(a.id).localeCompare(String(b.id)));
    return { list: good, omitted };
  }

  function findContact(req, res, room) {
    const found = contacts.byId(req.params.cid);
    const c = found && found.caseId === room.id && found.orgId === room.orgId ? found : null;
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
    player: findPlayer(room.playerId), org: req.org, guardians: guardians.forPlayer(room.playerId),
    isAdult, visibleToOrg, isBlocked, now: new Date(),
  });

  /**
   * The routing MODE the club asks for.
   *
   * `player_only` is the default and always available. `both` asks that the
   * player's own agent be a party as well; whether that is permitted is not the
   * club's call and not a stored flag — it is re-derived through the integration
   * seam at compose time AND again at send time.
   *
   * An unrecognised value is refused rather than quietly downgraded: a club that
   * typed something this build does not know deserves to be told, and silently
   * reading it as `player_only` would hide a client bug behind a safe default.
   */
  function modeOf(res, body) {
    const raw = body?.contactMode;
    if (raw === undefined || raw === null || raw === '') return 'player_only';
    if (typeof raw !== 'string' || !CONTACT_MODES.includes(raw)) {
      err(res, 'CONTACT_MODE_INVALID', 'contactMode must be "player_only" or "both". There is no mode that reaches an agent instead of the player.', { allowed: CONTACT_MODES });
      return null;
    }
    return raw;
  }

  /**
   * The whole routing answer: the canonical recipient AND whether the client's
   * agent is a valid second party right now. The seam owns the agent decision;
   * this file owns neither the representation rule nor the licence rule nor the
   * disclosure rule, so there is no second copy of any of them here.
   */
  function routeFor(req, room, requestedMode = 'player_only') {
    const base = recipientFor(req, room);
    if (!base.ok) return { recipient: base, routing: null };
    if (requestedMode === 'player_only') {
      return {
        recipient: base,
        routing: {
          ok: true, mode: 'player_only', targets: [base.recipient], agent: null,
          agentRefusal: null,
        },
      };
    }
    return {
      recipient: base,
      routing: integration.contactRoute({
        recipient: base.recipient, clientId: room.playerId, viewerOrgId: req.org.id, requestedMode,
      }),
    };
  }

  /**
   * What the club is told. The recipient type and the minor flag, plus
   * the agent answer: whether an agent is a party, and — when the club asked and
   * the answer was no — WHICH rule refused, as a code.
   *
   * The code names a category, never a person: `NO_REPRESENTATION` does not say
   * whether the player has an agent whose licence lapsed or no agent at all, and
   * `DISCLOSURE_WITHHELD` does not quote the client. A club learns what it may
   * do, not facts about the player it has not been given.
   */
  const routingView = (r, routing = null) => (r.ok
    ? {
      available: true,
      type: r.recipient.type,
      minor: r.recipient.minor,
      mode: routing?.mode ?? 'player_only',
      agentParty: !!routing?.agent,
      agentRefusal: routing?.agentRefusal ?? null,
      modes: CONTACT_MODES,
    }
    : { available: false, type: null, minor: null, reason: r.error, mode: null, agentParty: false, agentRefusal: null, modes: CONTACT_MODES });

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
   * The lifecycle coupling. The Contact does not write a case
   * status. It asks the ONE validator whether `recordContact` is possible —
   * with the real evidence provider, which sees this Contact — and, if
   * so, writes through the ONE status writer. "Already contacted" is
   * recorded on the Contact and is not an error.
   */
  function advanceCase(req, room, c, at) {
    const role = roleFor(req, room);
    const verdict = canTransitionRecruitmentCase(room, 'recordContact', { role, evidence: ctx.recruitmentEvidenceProvider, now: at });
    let moved = null; let lifecycle;
    if (verdict.ok) {
      const { from, to } = ctx.applyLifecycleTransition({ req, room, to: verdict.to, reasonCodes: [], trigger: `contact:${c.id}`, statusDetail: { lifecycleAction: 'recordContact', clientKey: null, policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION, contactId: c.id } });
      lifecycle = { applied: true, from, to, at };
      moved = { from, to };
    } else {
      // LIFECYCLE_NO_CHANGE (already contacted) is the expected second answer.
      // Anything else is recorded so the mismatch is visible, never hidden.
      lifecycle = { applied: false, reason: verdict.error, at };
      if (verdict.error !== 'LIFECYCLE_NO_CHANGE') console.error(`CONTACT lifecycle_not_applied ${c.id} ${verdict.error}`);
    }
    // The Contact records what happened to the case, written with the move.
    return { moved, contact: contacts.recordAct(c.id, { lifecycle }) };
  }

  // ---------------------------------------------------------------- list

  orgRouter.get('/rooms/:id/contacts', (req, res) => {
    const got = roomFor(req, res, 'contact_view');
    if (!got) return;
    const { room, role } = got;
    const { list, omitted } = contactsOf(room);
    // The preview asks for the widest mode the club could choose, so the club can
    // see whether an agent WOULD be a party before it drafts anything. Asking is
    // not routing: nothing is sent and nobody is told.
    const { recipient: routing, routing: route } = routeFor(req, room, 'both');
    const cooldown = cooldownFor(contacts.forOrgPlayer(room.orgId, room.playerId), { orgId: room.orgId, playerId: room.playerId, now: now() });
    res.json({
      items: list.map(contactView),
      omitted,
      routing: routingView(routing, route),
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

    const key = normaliseClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const content = validateContactContent(req.body ?? {});
    if (!content.ok) return err(res, content.error, content.message);
    const mode = modeOf(res, req.body);
    if (mode === null) return;
    // The mode is part of what makes this "the same request": the same words to
    // the player alone and the same words to the player and their agent are two
    // different contacts, and one clientKey must not stand for both.
    const fp = payloadFingerprint({ subject: content.subject, body: content.body, contactMode: mode });
    // A fingerprint over the words alone (no mode) still matches: the stored
    // record's own mode stands in for the one that fingerprint never carried,
    // so a genuinely different request (same key, different mode) still
    // conflicts.
    const legacyFp = payloadFingerprint({ subject: content.subject, body: content.body });
    const keyMatches = (c) => c.keys?.create?.fp === fp
      || (c.keys?.create?.fp === legacyFp && (c.contactMode ?? 'player_only') === mode);

    // Replay of the same create: the same Contact, not a second one.
    if (key.key) {
      const prior = contactsOf(room).list.find((c) => c.keys?.create?.key === key.key);
      if (prior && keyMatches(prior)) return res.json({ contact: contactView(prior), idempotent: true });
      if (prior) return err(res, 'CONTACT_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different draft.');
    }

    if (!caseGate(res, room)) return;
    if (limited('contact_draft', req.org.id)) return res.status(429).json(rateLimitedBody('contact_draft'));

    // A draft for someone the club cannot contact is refused at compose time,
    // and the same rule runs again at send time (block before compose).
    const { recipient: routing, routing: route } = routeFor(req, room, mode);
    if (!routing.ok) return err(res, routing.error, routing.message);

    if (!moderateOrRefuse(res, `${content.subject ?? ''}\n${content.body}`, { kind: 'recruitment_contact', orgId: req.org.id, userId: req.orgUser.id })) return;

    const at = now();
    const by = actorOf(req);
    const c = {
      id: nextId('rct'), orgId: room.orgId, caseId: room.id, playerId: room.playerId,
      status: 'draft', channel: 'in_app', recipient: null,
      // What the club ASKED for, and nothing more. `routingSnapshot` — what was
      // actually routed — is written only by a send, because a draft routed
      // nothing to anybody.
      contactMode: mode, routingSnapshot: null,
      subject: content.subject, body: content.body, summary: null,
      createdBy: by, createdAt: at, updatedAt: at,
      sentBy: null, sentAt: null, deliveredAt: null, failedAt: null, failureCode: null,
      attempts: [], requestId: null, emailCopy: null, lifecycle: null,
      occurredAt: null, recordedBy: null, recordedAt: null,
      respondedAt: null, response: null, cancelledAt: null, cancelledBy: null,
      keys: { create: key.key ? { key: key.key, fp } : null, send: null, record: null },
      history: [entry('contact_created', by, { channel: 'in_app', contactMode: mode }, at)], ...firstRev(req, at),
      policyVersion: CONTACT_POLICY_VERSION,
    };
    // NOTHING ELSE. No case history, no notification, no request row, no
    // outbox entry, no delivery state, and — even where an agent would be a
    // valid party — no agent is told anything. A draft is a record of intent.
    const stored = unit(() => {
      const fresh = contacts.create(c);
      broadcast('contact_created', { orgId: room.orgId, roomId: room.id, contactId: c.id });
      return fresh;
    });
    res.status(201).json({ contact: contactView(stored), routing: routingView(routing, route) });
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
    const mode = body.contactMode === undefined ? (c.contactMode ?? 'player_only') : modeOf(res, body);
    if (mode === null) return;
    const { recipient: routing, routing: route } = routeFor(req, room, mode);
    if (!routing.ok) return err(res, routing.error, routing.message);
    if (!moderateOrRefuse(res, `${content.subject ?? ''}\n${content.body}`, { kind: 'recruitment_contact', orgId: req.org.id, userId: req.orgUser.id })) return;

    const at = now();
    const changed = [
      ...(content.subject !== c.subject ? ['subject'] : []), ...(content.body !== c.body ? ['body'] : []),
      ...(mode !== (c.contactMode ?? 'player_only') ? ['contactMode'] : []),
    ];
    const stored = unit(() => contacts.editDraft(c.id, { subject: content.subject, body: content.body, contactMode: mode },
      byStaff(req, at, [entry('contact_edited', actorOf(req), { fields: changed }, at)])));
    res.json({ contact: contactView(stored), routing: routingView(routing, route) });
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
    // The draft text is KEPT. Cancelling records that nothing was sent; it does
    // not erase what was written.
    const stored = unit(() => contacts.cancel(c.id, { at, by: actorOf(req) }, byStaff(req, at, [entry('contact_cancelled', actorOf(req), null, at)])));
    res.json({ contact: contactView(stored) });
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
      // The replay answers with the Contact's CURRENT
      // truth — `delivered` is true only for a delivered (or answered)
      // Contact, never for one that failed and was then cancelled.
      if (holder && holder.id === c.id) return res.json({ contact: contactView(c), delivered: ['delivered', 'responded'].includes(c.status), idempotent: true });
    }

    // Validation before the rev guard, as the lifecycle route does: a stale
    // rev on an impossible action reports the impossibility.
    const verdict = canContactAction(c, 'send', { role });
    if (!verdict.ok) return err(res, verdict.error, verdict.message);
    if (!caseGate(res, room)) return;
    if (!revGate(req, res, c)) return;
    if (limited('contact_send', req.org.id)) return res.status(429).json(rateLimitedBody('contact_send'));

    // RE-DERIVED NOW: the player's age, the
    // guardian route, the block relation and the visibility wall are read at this
    // moment, not from the draft — and so is the AGENT's authority. A draft
    // composed while the relationship was active and the client's disclosure was
    // on sends to the player alone if either has since changed. The mode the club
    // stored is a request; this is the answer.
    const { recipient: routing, routing: route } = routeFor(req, room, c.contactMode ?? 'player_only');
    if (!routing.ok) return err(res, routing.error, routing.message);
    const recipient = routing.recipient;
    const player = findPlayer(room.playerId);

    const cooldown = cooldownFor(contacts.forOrgPlayer(room.orgId, room.playerId), { orgId: room.orgId, playerId: room.playerId, now: now(), exceptId: c.id });
    if (cooldown) return err(res, 'CONTACT_COOLDOWN', 'A contact was delivered to this player recently and has not been answered yet. Wait before sending another.', { retryAt: cooldown.retryAt });

    const content = validateContactContent({ subject: c.subject, body: c.body });
    if (!content.ok) return err(res, content.error, content.message);
    if (!moderateOrRefuse(res, `${c.subject ?? ''}\n${c.body}`, { kind: 'recruitment_contact', orgId: req.org.id, userId: req.orgUser.id })) return;

    const at = now();
    const by = actorOf(req);
    const sendKey = { key: key.key ?? null, fp: payloadFingerprint({ contactId: c.id }) };

    // ---- the transport. The in-app Inbox is the transport of record: the
    // request row is the message in the recipient's mailbox. A refusal here
    // (injected for tests, or a real persistence problem surfaced by the
    // caller) leaves an honest `failed` attempt and no recipient object.
    if (ctx.operations.delivery.injected('contact') > 0) {
      const failed = unit(() => {
        ctx.operations.delivery.consumeInjectedFailure('contact'); // used up in the unit that records the failed attempt
        const fresh = contacts.recordSendFailure(c.id, { at, sendKey, code: 'TRANSPORT_REFUSED' },
          byStaff(req, at, [entry('contact_send_failed', by, { code: 'TRANSPORT_REFUSED', attempt: c.attempts.length + 1 }, at)]));
        broadcast('contact_failed', { orgId: room.orgId, roomId: room.id, contactId: c.id });
        return fresh;
      });
      console.error(`CONTACT transport_failed ${c.id} attempt=${failed.attempts.length}`);
      return res.json({ contact: contactView(failed), delivered: false });
    }

    // A courtesy email copy to the GUARDIAN only (a player record carries no
    // email). It is a notification that something is waiting in ScoutBox —
    // never the body, never the transport of record, never "delivered". The
    // provider is called after COMMIT; its outcome is a later write of its own.
    const guardian = recipient.type === 'guardian' && mailer ? guardians.byId(recipient.guardianId) : null;
    const emailCopy = recipient.type === 'guardian' && mailer ? { state: guardian?.email ? 'queued' : 'not_available', to: 'guardian', outboxId: null, at } : null;

    let moved = null;
    const sent = unit(() => {
      const request = issueRecruitmentRequest({
        org: req.org, orgUser: req.orgUser, player, type: 'contact',
        message: c.body, subject: c.subject, contactId: c.id,
        guardianId: recipient.guardianId, at,
      });
      // The Contact is delivered BEFORE the case is asked to move: the evidence
      // provider reads this Contact as the evidence for `recordContact`.
      // WHO WAS VALIDLY ROUTED, at this moment, as roles and ids. A later
      // change to the relationship does not rewrite it and the next contact is
      // routed from the authority in force then. The snapshot is what the agent's
      // own read is filtered by, so it is the record of participation, not a label.
      const routingSnapshot = integration.contactTargetSnapshot(route, at);
      const history = [entry('contact_sent', by, {
        channel: 'in_app', recipientType: recipient.type, attempt: c.attempts.length + 1,
        mode: route.mode, agentParty: !!route.agent,
      }, at)];
      // A club that asked for the agent and did not get one is told so IN THE
      // RECORD, not only in the response: the history is where a club later looks
      // to understand who saw a message.
      if ((c.contactMode ?? 'player_only') !== 'player_only' && !route.agent) {
        history.push(entry('contact_agent_routing_refused', by, { reasonCode: route.agentRefusal ?? 'NO_REPRESENTATION' }, at));
      }
      const delivered = contacts.recordDelivery(c.id, { at, by, sendKey, recipient, requestId: request.id, routingSnapshot, emailCopy }, byStaff(req, at, history));
      const advanced = advanceCase(req, room, delivered, at);
      moved = advanced.moved;

      // The agent hears through the canonical notification stream
      // into the Agent workspace's OWN Inbox. No second Inbox is created, no
      // request row is written for the agent, and the agent cannot answer:
      // accepting or declining belongs to the person the message is about. The text
      // carries the club's name and nothing about the club's recruitment process.
      if (route.agent?.agentUserId) {
        notify({ kind: 'org_user', id: route.agent.agentUserId }, 'representation_contact',
          `${req.org.name} has sent your client a message and routed you a copy. Your client answers it themselves, in their own Inbox.`, c.id);
        broadcast('contact_agent_routed', { orgId: room.orgId, contactId: c.id, agentUserId: route.agent.agentUserId });
      }
      broadcast('contact_sent', { orgId: room.orgId, roomId: room.id, contactId: c.id });
      return advanced.contact;
    });

    if (emailCopy?.state === 'queued') {
      // The provider's answer is its own explicit write, after the send committed.
      const settle = (copy) => {
        try { contacts.setEmailCopy(c.id, { copy }); } catch (e) { console.error(`CONTACT email_copy_not_recorded ${c.id}: ${e?.message ?? e}`); }
      };
      afterCommit(() => mailer.send({
        to: guardian.email,
        subject: `${req.org.name} has sent a message about ${player.name} on ScoutBox`,
        text: `Hi ${guardian.name},\n\n${req.org.name} (${req.orgUser.role || 'Scout'}: ${req.orgUser.name}) has sent a message about ${player.name} in ScoutBox.\n\nOpen your ScoutBox guardian Inbox to read it and respond. Nothing about this contact happens outside ScoutBox unless you choose to accept it.`,
      }).then((rec) => {
        settle({ state: mailer.transport === 'dev-outbox' ? 'local_outbox' : (rec?.delivered ? 'accepted_by_provider' : 'failed'), to: 'guardian', outboxId: rec?.id ?? null, at: rec?.ts ?? Date.now() });
      }, () => {
        settle({ state: 'failed', to: 'guardian', outboxId: null, at: Date.now() });
      }));
    }
    res.json({
      contact: contactView(sent), delivered: true,
      routing: routingView(routing, route),
      case: moved ? { from: moved.from, to: moved.to } : { unchanged: true, status: room.room.status },
    });
  });

  // ------------------------------------------------------- external record

  orgRouter.post('/rooms/:id/contacts/external', (req, res) => {
    const got = roomFor(req, res, 'contact_write');
    if (!got) return;
    const { room } = got;

    const key = normaliseClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const body = req.body ?? {};
    if (body.recipientType === undefined) return err(res, 'CONTACT_CONTENT_INVALID', 'recipientType is required: who did you speak to, the player or the guardian?');

    // Who the club MAY have spoken to is derived, then compared with what the
    // club says. A minor recorded as "the player" is refused, not corrected.
    //
    // An attested external contact carries NO routing mode: ScoutBox did not
    // observe it and routed nothing. The `agent` channel already exists for "we
    // spoke via the agent or guardian" and is a statement about the world, not a
    // ScoutBox permission — so it grants the agent no read here.
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
      contactMode: 'player_only', routingSnapshot: null,
      subject: null, body: null, summary: check.summary,
      createdBy: by, createdAt: at, updatedAt: at,
      sentBy: null, sentAt: null, deliveredAt: null, failedAt: null, failureCode: null,
      attempts: [], requestId: null, emailCopy: null, lifecycle: null,
      occurredAt: check.occurredAt, recordedBy: by, recordedAt: at,
      respondedAt: null, response: null, cancelledAt: null, cancelledBy: null,
      keys: { create: null, send: null, record: key.key ? { key: key.key, fp } : null },
      history: [entry('contact_external_recorded', by, { channel: check.channel, occurredAt: check.occurredAt, recipientType: routing.recipient.type }, at)], ...firstRev(req, at),
      policyVersion: CONTACT_POLICY_VERSION,
    };
    let moved = null;
    const stored = unit(() => {
      // Written BEFORE the case is asked to move: the evidence provider reads it.
      const advanced = advanceCase(req, room, contacts.create(c), at);
      moved = advanced.moved;
      broadcast('contact_external_recorded', { orgId: room.orgId, roomId: room.id, contactId: c.id });
      return advanced.contact;
    });
    res.status(201).json({ contact: contactView(stored), case: moved ? { from: moved.from, to: moved.to } : { unchanged: true, status: room.room.status } });
  });

  // ------------------------------------------------------------- response

  /**
   * Called by the respond routes once a request row that a
   * Contact created has been accepted or declined. The recipient never
   * addresses the Contact; the Contact learns of the answer — in the respond
   * route's unit of work, so the answer and the Contact commit together.
   */
  ctx.onRequestResponded = ({ request, accept, message = null, by, at = Date.now() }) => {
    if (!request?.contactId) return null;
    const found = contacts.byId(request.contactId);
    if (!found || found.requestId !== request.id || found.status !== 'delivered') return null;
    const kind = accept ? 'accepted' : 'declined';
    const c = contacts.recordResponse(found.id, { response: { kind, message: message || null, by, at } }, {
      at, revBy: null, touch: true, bump: true, history: [entry('contact_responded', { kind: by, name: by === 'guardian' ? 'Guardian' : 'Player' }, { kind }, at)],
    });

    // The sender already hears through the respond route's own notification.
    // The room's owner and lead scout hear too, if they are different people;
    // nobody else in the organisation does.
    const room = recruitmentReads.cases.byId(c.caseId);
    if (room) {
      for (const uid of new Set([room.ownerUserId, room.room?.leadScoutUserId])) {
        if (!uid || uid === request.userId) continue;
        notify({ kind: 'org_user', id: uid }, 'recruitment_room', `Recruitment Room — ${room.playerName ?? 'a removed player'}: the ${by} ${kind} your contact.`, room.id);
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
      modes: CONTACT_MODES,
      note: 'A draft is not a contact. Delivered means the message is in the recipient\'s ScoutBox Inbox; ScoutBox does not report whether it was read.',
      agentNote: 'You may ask that the player\'s own agent be a party as well ("both"). Whether that is permitted is decided by the player\'s relationship, the agent\'s licence and the player\'s own choice — and it is decided again when you send. There is no mode that reaches an agent instead of the player.',
    });
  });

  return { contactsOf, byAtThenId };
}
