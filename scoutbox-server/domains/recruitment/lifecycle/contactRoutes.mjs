/**
 * Contact routes: the club side of one communication process.
 *
 * There is no recipient route here. The recipient answers the request row the
 * send creates through the existing Inbox respond route, which calls
 * `ctx.onRequestResponded` (registered here) so the answer lands on the Contact.
 *
 * A send's request row, Contact and lifecycle entry commit in one unit of
 * work, so the case cannot say `contacted` while the Contact that justifies it
 * was lost.
 */

import { visibleToOrg } from '../../../domain.mjs';
import { roomRole, ROOM_STATUS_LABELS } from '../rooms/shared.mjs';
import { guardRev, expectedRevOf } from '../../platform/concurrency.mjs';
import { rateLimitedBody, limitCheck } from '../../platform/rateLimit.mjs';
import { canTransitionRecruitmentCase, RECRUITMENT_LIFECYCLE_POLICY_VERSION } from './lifecycle.mjs';
import { sendDomainError } from './errors.mjs';
import {
  CONTACT_POLICY_VERSION,
  CONTACT_LIMITS,
  CONTACT_CHANNELS,
  EXTERNAL_CHANNELS,
  CONTACT_STATUSES,
  CONTACT_CASE_STATUSES,
  CONTACT_MODES,
  canContactAction,
  contactRoleAllows,
  validateContactContent,
  normaliseClientKey,
  resolveContactRecipient,
  validateExternalRecord,
  cooldownFor,
  payloadFingerprint,
  contactView,
  contactIntegrity,
  caseAcceptsContact,
  byAtThenId,
} from './contact.mjs';
import { now } from '../../platform/clock.mjs';

import * as v from 'valibot';
import { parseInput, REV_FIELD_CODES, REV_FIELDS } from '../../platform/schemas.mjs';

// Shape and type only. validateContactContent cleans the words and judges their length (markup is stripped
// first, so the raw text may run longer than the limit), and modeOf words the one refusal of a mode.
const WORDS = { subject: v.nullish(v.string()), body: v.nullish(v.string()), contactMode: v.nullish(v.string()) };
// `clientKey` keeps the platform's idempotency-key rule (normaliseClientKey).
const KEY = { clientKey: v.optional(v.unknown()) };
const NewContact = v.strictObject({ ...WORDS, ...KEY });
const ContactEdit = v.strictObject({ ...WORDS, ...REV_FIELDS });
const ContactCancel = v.strictObject(REV_FIELDS);
const ContactSend = v.strictObject({ ...KEY, ...REV_FIELDS });
// The channel, the time and the recipient are judged by validateExternalRecord, which keeps their codes.
const ExternalContact = v.strictObject({
  ...KEY,
  channel: v.optional(v.unknown()),
  occurredAt: v.optional(v.unknown()),
  summary: v.nullish(v.string()),
  recipientType: v.optional(v.string()),
});
export const CONTACT_INPUT_CODES = Object.freeze({
  codes: { FIELD_INVALID: 'CONTACT_CONTENT_INVALID' },
  fieldCodes: {
    ...REV_FIELD_CODES,
    contactMode: 'CONTACT_MODE_INVALID',
  },
});

export function registerContact(ctx) {
  const {
    guardians,
    orgRouter,
    nextId,
    notify,
    broadcast,
    findPlayer,
    isBlocked,
    isAdult,
    rateLimit,
    mailer,
    isLead,
    moderateOrRefuse,
    issueRecruitmentRequest,
    recruitmentContactsOffers,
    unit,
    afterCommit,
    recruitmentReads,
    integration,
  } = ctx;

  if (typeof unit !== 'function' || typeof afterCommit !== 'function' || !recruitmentContactsOffers?.contacts)
    throw new TypeError(
      'registerContact needs the contacts/offers repository, unit and afterCommit from the data layer',
    );
  if (typeof integration?.contactRoute !== 'function' || typeof integration?.contactTargetSnapshot !== 'function')
    throw new TypeError('registerContact needs the cross-app integration seam (ctx.integration)');
  const contacts = recruitmentContactsOffers.contacts;
  const actorOf = (req) => ({ kind: 'org', userId: req.orgUser.id, name: req.orgUser.name });
  const roleFor = (req, room) => roomRole({ room, user: req.orgUser, isLead: isLead(req.orgUser) });
  const limited = limitCheck(rateLimit);
  const err = (res, error, message, extra = {}) => sendDomainError(res, { error, message, ...extra }, 'contact');

  /** The caller passes the moment the event happened, so one act has one clock. */
  const entry = (action, by, detail, at) => ({ id: nextId('aud'), at, action, by, detail: detail ?? null });
  const byStaff = (req, at, history) => ({ at, revBy: req.orgUser, touch: true, bump: true, history });
  const firstRev = (req, at) => ({ rev: 1, revAt: at, revBy: { userId: req.orgUser.id, name: req.orgUser.name } });

  // ------------------------------------------------------------- lookups

  /** Through the rooms' concealing lookup. */
  function roomFor(req, res, need) {
    const room = ctx.findRoomForRequest(req, res);
    if (!room) return null;
    const role = roleFor(req, room);
    if (!contactRoleAllows(role, need)) {
      err(
        res,
        'CONTACT_NOT_PERMITTED',
        need === 'contact_write'
          ? 'Only a room lead or recruitment lead can draft, send or record a contact.'
          : 'Your role cannot read contacts in this room.',
      );
      return null;
    }
    return { room, role };
  }

  function contactsOf(room) {
    const good = [];
    let omitted = 0;
    for (const c of contacts.forCase(room.id)) {
      if (c.orgId !== room.orgId) continue;
      const problems = contactIntegrity(c, { orgId: room.orgId, caseId: room.id });
      if (problems.length) {
        omitted += 1;
        console.error(`CONTACT integrity ${c.id ?? '?'}: ${problems.join(',')}`);
        continue;
      }
      good.push(c);
    }
    good.sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
    return { list: good, omitted };
  }

  function findContact(req, res, room) {
    const found = contacts.byId(req.params.cid);
    const c = found && found.caseId === room.id && found.orgId === room.orgId ? found : null;
    if (!c) {
      err(res, 'CONTACT_NOT_FOUND', 'No such contact.');
      return null;
    }
    const problems = contactIntegrity(c, { orgId: room.orgId, caseId: room.id });
    if (problems.length) {
      console.error(`CONTACT integrity ${c.id}: ${problems.join(',')}`);
      err(res, 'CONTACT_STATE_UNKNOWN', 'This contact cannot be read.');
      return null;
    }
    return c;
  }

  /** Computed now, never trusted from a client. */
  const recipientFor = (req, room) =>
    resolveContactRecipient({
      player: findPlayer(room.playerId),
      org: req.org,
      guardians: guardians.forPlayer(room.playerId),
      isAdult,
      visibleToOrg,
      isBlocked,
      now: new Date(),
    });

  /**
   * `both` asks that the player's agent be a party too; whether that is
   * permitted is re-derived through the integration seam at compose time and
   * again at send. An unrecognised value is refused rather than read as
   * `player_only`, which would hide a client bug behind a safe default.
   */
  /** The request body read with its schema, or `undefined` once the refusal is sent. */
  const contactInput = (res, schema, body) => {
    const parsed = parseInput(schema, body ?? {}, CONTACT_INPUT_CODES);
    if (parsed.ok) return parsed.value;
    sendDomainError(res, parsed, 'contact');
    return undefined;
  };

  function modeOf(res, body) {
    const raw = body?.contactMode;
    if (raw === undefined || raw === null || raw === '') return 'player_only';
    if (typeof raw !== 'string' || !CONTACT_MODES.includes(raw)) {
      err(
        res,
        'CONTACT_MODE_INVALID',
        'contactMode must be "player_only" or "both". There is no mode that reaches an agent instead of the player.',
        { allowed: CONTACT_MODES },
      );
      return null;
    }
    return raw;
  }

  /** The seam owns the agent decision (representation, licence and disclosure rules). */
  function routeFor(req, room, requestedMode = 'player_only') {
    const base = recipientFor(req, room);
    if (!base.ok) return { recipient: base, routing: null };
    if (requestedMode === 'player_only') {
      return {
        recipient: base,
        routing: {
          ok: true,
          mode: 'player_only',
          targets: [base.recipient],
          agent: null,
          agentRefusal: null,
        },
      };
    }
    return {
      recipient: base,
      routing: integration.contactRoute({
        recipient: base.recipient,
        clientId: room.playerId,
        viewerOrgId: req.org.id,
        requestedMode,
      }),
    };
  }

  /**
   * The refusal code names a category, never a person: `NO_REPRESENTATION` does
   * not say whether the player has a lapsed agent or none, and
   * `DISCLOSURE_WITHHELD` does not quote the client.
   */
  const routingView = (r, routing = null) =>
    r.ok
      ? {
          available: true,
          type: r.recipient.type,
          minor: r.recipient.minor,
          mode: routing?.mode ?? 'player_only',
          agentParty: !!routing?.agent,
          agentRefusal: routing?.agentRefusal ?? null,
          modes: CONTACT_MODES,
        }
      : {
          available: false,
          type: null,
          minor: null,
          reason: r.error,
          mode: null,
          agentParty: false,
          agentRefusal: null,
          modes: CONTACT_MODES,
        };

  /** The case must have agreed to approach the player (contact_planned) or already have done so. */
  function caseGate(res, room) {
    if (caseAcceptsContact(room.room?.status)) return true;
    err(
      res,
      'CONTACT_CASE_STATE',
      `A case at "${ROOM_STATUS_LABELS[room.room?.status] ?? room.room?.status}" cannot contact the player. Plan the contact first (planContact).`,
      { allowed: CONTACT_CASE_STATUSES },
    );
    return false;
  }

  /** Required on a mutation of an existing Contact; absent is refused, never coerced. */
  function revGate(req, res, c) {
    const exp = expectedRevOf(req.body);
    if (exp === null) {
      err(res, 'CONTACT_REV_REQUIRED', 'expectedRev is required: send the rev you were editing.');
      return false;
    }
    return guardRev(req, res, c, { errorCode: 'CONTACT_VERSION_CONFLICT', current: { status: c.status } });
  }

  /**
   * The Contact writes no case status: it asks the validator whether
   * `recordContact` is possible (the evidence provider sees this Contact) and
   * writes through the status writer. "Already contacted" is not an error.
   */
  function advanceCase(req, room, c, at) {
    const role = roleFor(req, room);
    const verdict = canTransitionRecruitmentCase(room, 'recordContact', {
      role,
      evidence: ctx.recruitmentEvidenceProvider,
      now: at,
    });
    let moved = null;
    let lifecycle;
    if (verdict.ok) {
      const { from, to } = ctx.applyLifecycleTransition({
        req,
        room,
        to: verdict.to,
        reasonCodes: [],
        trigger: `contact:${c.id}`,
        statusDetail: {
          lifecycleAction: 'recordContact',
          clientKey: null,
          policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION,
          contactId: c.id,
        },
      });
      lifecycle = { applied: true, from, to, at };
      moved = { from, to };
    } else {
      // Anything but LIFECYCLE_NO_CHANGE (already contacted) is logged so the mismatch is visible.
      lifecycle = { applied: false, reason: verdict.error, at };
      if (verdict.error !== 'LIFECYCLE_NO_CHANGE')
        console.error(`CONTACT lifecycle_not_applied ${c.id} ${verdict.error}`);
    }
    return { moved, contact: contacts.recordAct(c.id, { lifecycle }) };
  }

  // ---------------------------------------------------------------- list

  orgRouter.get('/rooms/:id/contacts', (req, res) => {
    const got = roomFor(req, res, 'contact_view');
    if (!got) return;
    const { room, role } = got;
    const { list, omitted } = contactsOf(room);
    // The preview asks for the widest mode so the club can see whether an agent
    // would be a party before drafting. Nothing is sent and nobody is told.
    const { recipient: routing, routing: route } = routeFor(req, room, 'both');
    const cooldown = cooldownFor(contacts.forOrgPlayer(room.orgId, room.playerId), {
      orgId: room.orgId,
      playerId: room.playerId,
      now: now(),
    });
    res.json({
      items: list.map(contactView),
      omitted,
      routing: routingView(routing, route),
      case: {
        status: room.room.status,
        acceptsContact: caseAcceptsContact(room.room.status),
        planAction: 'planContact',
      },
      canWrite: contactRoleAllows(role, 'contact_write'),
      cooldown: cooldown ? { until: cooldown.retryAt } : null,
      channels: {
        inApp: 'in_app',
        external: EXTERNAL_CHANNELS.map((id) => ({ id, label: CONTACT_CHANNELS[id].label })),
      },
      limits: {
        subject: CONTACT_LIMITS.subject,
        body: CONTACT_LIMITS.body,
        summary: CONTACT_LIMITS.summary,
        replyMessage: CONTACT_LIMITS.replyMessage,
      },
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

    const input = contactInput(res, NewContact, req.body);
    if (!input) return;
    const key = normaliseClientKey(input.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const content = validateContactContent(input);
    if (!content.ok) return err(res, content.error, content.message);
    const mode = modeOf(res, input);
    if (mode === null) return;
    // The same words to the player alone and to the player and agent are two
    // different contacts, so the mode is part of the fingerprint.
    const fp = payloadFingerprint({ subject: content.subject, body: content.body, contactMode: mode });
    // A fingerprint over the words alone still matches when the stored mode
    // agrees, so same key with a different mode still conflicts.
    const legacyFp = payloadFingerprint({ subject: content.subject, body: content.body });
    const keyMatches = (c) =>
      c.keys?.create?.fp === fp || (c.keys?.create?.fp === legacyFp && (c.contactMode ?? 'player_only') === mode);

    if (key.key) {
      const prior = contactsOf(room).list.find((c) => c.keys?.create?.key === key.key);
      if (prior && keyMatches(prior)) return res.json({ contact: contactView(prior), idempotent: true });
      if (prior)
        return err(res, 'CONTACT_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different draft.');
    }

    if (!caseGate(res, room)) return;
    if (limited('contact_draft', req.org.id)) return res.status(429).json(rateLimitedBody('contact_draft'));

    // Refused at compose time, and the same rule runs again at send.
    const { recipient: routing, routing: route } = routeFor(req, room, mode);
    if (!routing.ok) return err(res, routing.error, routing.message);

    if (
      !moderateOrRefuse(res, `${content.subject ?? ''}\n${content.body}`, {
        kind: 'recruitment_contact',
        orgId: req.org.id,
        userId: req.orgUser.id,
      })
    )
      return;

    const at = now();
    const by = actorOf(req);
    const c = {
      id: nextId('rct'),
      orgId: room.orgId,
      caseId: room.id,
      playerId: room.playerId,
      status: 'draft',
      channel: 'in_app',
      recipient: null,
      // `routingSnapshot` (what was actually routed) is written only by a send.
      contactMode: mode,
      routingSnapshot: null,
      subject: content.subject,
      body: content.body,
      summary: null,
      createdBy: by,
      createdAt: at,
      updatedAt: at,
      sentBy: null,
      sentAt: null,
      deliveredAt: null,
      failedAt: null,
      failureCode: null,
      attempts: [],
      requestId: null,
      emailCopy: null,
      lifecycle: null,
      occurredAt: null,
      recordedBy: null,
      recordedAt: null,
      respondedAt: null,
      response: null,
      cancelledAt: null,
      cancelledBy: null,
      keys: { create: key.key ? { key: key.key, fp } : null, send: null, record: null },
      history: [entry('contact_created', by, { channel: 'in_app', contactMode: mode }, at)],
      ...firstRev(req, at),
      policyVersion: CONTACT_POLICY_VERSION,
    };
    // A draft is a record of intent: no case history, notification, request
    // row or delivery state, and no agent is told anything.
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
    const body = contactInput(res, ContactEdit, req.body);
    if (!body) return;
    if (!revGate(req, res, c)) return;

    const content = validateContactContent({
      subject: body.subject === undefined ? c.subject : body.subject,
      body: body.body === undefined ? c.body : body.body,
    });
    if (!content.ok) return err(res, content.error, content.message);
    const mode = body.contactMode === undefined ? (c.contactMode ?? 'player_only') : modeOf(res, body);
    if (mode === null) return;
    const { recipient: routing, routing: route } = routeFor(req, room, mode);
    if (!routing.ok) return err(res, routing.error, routing.message);
    if (
      !moderateOrRefuse(res, `${content.subject ?? ''}\n${content.body}`, {
        kind: 'recruitment_contact',
        orgId: req.org.id,
        userId: req.orgUser.id,
      })
    )
      return;

    const at = now();
    const changed = [
      ...(content.subject !== c.subject ? ['subject'] : []),
      ...(content.body !== c.body ? ['body'] : []),
      ...(mode !== (c.contactMode ?? 'player_only') ? ['contactMode'] : []),
    ];
    const stored = unit(() =>
      contacts.editDraft(
        c.id,
        { subject: content.subject, body: content.body, contactMode: mode },
        byStaff(req, at, [entry('contact_edited', actorOf(req), { fields: changed }, at)]),
      ),
    );
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
    if (!contactInput(res, ContactCancel, req.body)) return;
    if (!revGate(req, res, c)) return;
    const at = now();
    // The draft text is kept: cancelling records that nothing was sent.
    const stored = unit(() =>
      contacts.cancel(
        c.id,
        { at, by: actorOf(req) },
        byStaff(req, at, [entry('contact_cancelled', actorOf(req), null, at)]),
      ),
    );
    res.json({ contact: contactView(stored) });
  });

  // ----------------------------------------------------------------- send

  orgRouter.post('/rooms/:id/contacts/:cid/send', (req, res) => {
    const got = roomFor(req, res, 'contact_write');
    if (!got) return;
    const { room, role } = got;
    const c = findContact(req, res, room);
    if (!c) return;

    const input = contactInput(res, ContactSend, req.body);
    if (!input) return;
    const key = normaliseClientKey(input.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    if (key.key) {
      // A send key is bound to the Contact it first sent.
      const holder = contactsOf(room).list.find((x) => x.keys?.send?.key === key.key);
      if (holder && holder.id !== c.id)
        return err(res, 'CONTACT_IDEMPOTENCY_CONFLICT', 'This clientKey was already used to send a different contact.');
      // `delivered` reflects the Contact's current truth, never true for one that failed and was then cancelled.
      if (holder && holder.id === c.id)
        return res.json({
          contact: contactView(c),
          delivered: ['delivered', 'responded'].includes(c.status),
          idempotent: true,
        });
    }

    // Validation before the rev guard, so a stale rev on an impossible action reports the impossibility.
    const verdict = canContactAction(c, 'send', { role });
    if (!verdict.ok) return err(res, verdict.error, verdict.message);
    if (!caseGate(res, room)) return;
    if (!revGate(req, res, c)) return;
    if (limited('contact_send', req.org.id)) return res.status(429).json(rateLimitedBody('contact_send'));

    // Re-derived now, not from the draft: age, guardian route, block, visibility
    // and the agent's authority. A draft composed while the agent was permitted
    // sends to the player alone if that has since changed.
    const { recipient: routing, routing: route } = routeFor(req, room, c.contactMode ?? 'player_only');
    if (!routing.ok) return err(res, routing.error, routing.message);
    const recipient = routing.recipient;
    const player = findPlayer(room.playerId);

    const cooldown = cooldownFor(contacts.forOrgPlayer(room.orgId, room.playerId), {
      orgId: room.orgId,
      playerId: room.playerId,
      now: now(),
      exceptId: c.id,
    });
    if (cooldown)
      return err(
        res,
        'CONTACT_COOLDOWN',
        'A contact was delivered to this player recently and has not been answered yet. Wait before sending another.',
        { retryAt: cooldown.retryAt },
      );

    const content = validateContactContent({ subject: c.subject, body: c.body });
    if (!content.ok) return err(res, content.error, content.message);
    if (
      !moderateOrRefuse(res, `${c.subject ?? ''}\n${c.body}`, {
        kind: 'recruitment_contact',
        orgId: req.org.id,
        userId: req.orgUser.id,
      })
    )
      return;

    const at = now();
    const by = actorOf(req);
    const sendKey = { key: key.key ?? null, fp: payloadFingerprint({ contactId: c.id }) };

    // The in-app Inbox is the transport of record. A refusal leaves an honest
    // `failed` attempt and no recipient object.
    if (ctx.operations.delivery.injected('contact') > 0) {
      const failed = unit(() => {
        ctx.operations.delivery.consumeInjectedFailure('contact'); // used up in the unit that records the failed attempt
        const fresh = contacts.recordSendFailure(
          c.id,
          { at, sendKey, code: 'TRANSPORT_REFUSED' },
          byStaff(req, at, [
            entry('contact_send_failed', by, { code: 'TRANSPORT_REFUSED', attempt: c.attempts.length + 1 }, at),
          ]),
        );
        broadcast('contact_failed', { orgId: room.orgId, roomId: room.id, contactId: c.id });
        return fresh;
      });
      console.error(`CONTACT transport_failed ${c.id} attempt=${failed.attempts.length}`);
      return res.json({ contact: contactView(failed), delivered: false });
    }

    // A courtesy email to the guardian only (a player record carries no email):
    // never the body, never the transport of record, never "delivered". Sent
    // after commit; its outcome is a later write of its own.
    const guardian = recipient.type === 'guardian' && mailer ? guardians.byId(recipient.guardianId) : null;
    const emailCopy =
      recipient.type === 'guardian' && mailer
        ? { state: guardian?.email ? 'queued' : 'not_available', to: 'guardian', outboxId: null, at }
        : null;

    let moved = null;
    const sent = unit(() => {
      const request = issueRecruitmentRequest({
        org: req.org,
        orgUser: req.orgUser,
        player,
        type: 'contact',
        message: c.body,
        subject: c.subject,
        contactId: c.id,
        guardianId: recipient.guardianId,
        at,
      });
      // Delivered before the case is asked to move: the evidence provider reads
      // this Contact. The snapshot records who was validly routed at this moment;
      // later relationship changes do not rewrite it, and the agent's own read is filtered by it.
      const routingSnapshot = integration.contactTargetSnapshot(route, at);
      const history = [
        entry(
          'contact_sent',
          by,
          {
            channel: 'in_app',
            recipientType: recipient.type,
            attempt: c.attempts.length + 1,
            mode: route.mode,
            agentParty: !!route.agent,
          },
          at,
        ),
      ];
      // Recorded in the history, not only the response: that is where a club
      // later looks to understand who saw a message.
      if ((c.contactMode ?? 'player_only') !== 'player_only' && !route.agent) {
        history.push(
          entry('contact_agent_routing_refused', by, { reasonCode: route.agentRefusal ?? 'NO_REPRESENTATION' }, at),
        );
      }
      const delivered = contacts.recordDelivery(
        c.id,
        { at, by, sendKey, recipient, requestId: request.id, routingSnapshot, emailCopy },
        byStaff(req, at, history),
      );
      const advanced = advanceCase(req, room, delivered, at);
      moved = advanced.moved;

      // The agent hears through the notification stream into the Agent
      // workspace's own Inbox and cannot answer: accepting or declining belongs
      // to the person the message is about.
      if (route.agent?.agentUserId) {
        notify(
          { kind: 'org_user', id: route.agent.agentUserId },
          'representation_contact',
          `${req.org.name} has sent your client a message and routed you a copy. Your client answers it themselves, in their own Inbox.`,
          c.id,
        );
        broadcast('contact_agent_routed', { orgId: room.orgId, contactId: c.id, agentUserId: route.agent.agentUserId });
      }
      broadcast('contact_sent', { orgId: room.orgId, roomId: room.id, contactId: c.id });
      return advanced.contact;
    });

    if (emailCopy?.state === 'queued') {
      const settle = (copy) => {
        try {
          contacts.setEmailCopy(c.id, { copy });
        } catch (e) {
          console.error(`CONTACT email_copy_not_recorded ${c.id}: ${e?.message ?? e}`);
        }
      };
      afterCommit(() =>
        mailer
          .send({
            to: guardian.email,
            subject: `${req.org.name} has sent a message about ${player.name} on ScoutBox`,
            text: `Hi ${guardian.name},\n\n${req.org.name} (${req.orgUser.role || 'Scout'}: ${req.orgUser.name}) has sent a message about ${player.name} in ScoutBox.\n\nOpen your ScoutBox guardian Inbox to read it and respond. Nothing about this contact happens outside ScoutBox unless you choose to accept it.`,
          })
          .then(
            (rec) => {
              settle({
                state:
                  mailer.transport === 'dev-outbox'
                    ? 'local_outbox'
                    : rec?.delivered
                      ? 'accepted_by_provider'
                      : 'failed',
                to: 'guardian',
                outboxId: rec?.id ?? null,
                at: rec?.ts ?? Date.now(),
              });
            },
            () => {
              settle({ state: 'failed', to: 'guardian', outboxId: null, at: Date.now() });
            },
          ),
      );
    }
    res.json({
      contact: contactView(sent),
      delivered: true,
      routing: routingView(routing, route),
      case: moved ? { from: moved.from, to: moved.to } : { unchanged: true, status: room.room.status },
    });
  });

  // ------------------------------------------------------- external record

  orgRouter.post('/rooms/:id/contacts/external', (req, res) => {
    const got = roomFor(req, res, 'contact_write');
    if (!got) return;
    const { room } = got;

    const body = contactInput(res, ExternalContact, req.body);
    if (!body) return;
    const key = normaliseClientKey(body.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    if (body.recipientType === undefined)
      return err(
        res,
        'CONTACT_CONTENT_INVALID',
        'recipientType is required: who did you speak to, the player or the guardian?',
      );

    // A minor recorded as "the player" is refused, not corrected. An external
    // contact carries no routing mode, and the `agent` channel is a statement
    // about the world that grants the agent no read.
    const routing = recipientFor(req, room);
    if (!routing.ok) return err(res, routing.error, routing.message);
    const check = validateExternalRecord(body, { now: now(), derivedRecipientType: routing.recipient.type });
    if (!check.ok) return err(res, check.error, check.message, check.allowed ? { allowed: check.allowed } : {});
    const fp = payloadFingerprint({
      channel: check.channel,
      occurredAt: check.occurredAt,
      summary: check.summary,
      recipientType: routing.recipient.type,
    });

    if (key.key) {
      const prior = contactsOf(room).list.find((c) => c.keys?.record?.key === key.key);
      if (prior && prior.keys.record.fp === fp) return res.json({ contact: contactView(prior), idempotent: true });
      if (prior)
        return err(
          res,
          'CONTACT_IDEMPOTENCY_CONFLICT',
          'This clientKey was already used to record a different contact.',
        );
    }
    if (!caseGate(res, room)) return;
    if (limited('contact_external_record', req.org.id))
      return res.status(429).json(rateLimitedBody('contact_external_record'));
    if (
      check.summary &&
      !moderateOrRefuse(res, check.summary, {
        kind: 'recruitment_contact_record',
        orgId: req.org.id,
        userId: req.orgUser.id,
      })
    )
      return;

    const at = now();
    const by = actorOf(req);
    const c = {
      id: nextId('rct'),
      orgId: room.orgId,
      caseId: room.id,
      playerId: room.playerId,
      status: 'recorded',
      channel: check.channel,
      recipient: routing.recipient,
      contactMode: 'player_only',
      routingSnapshot: null,
      subject: null,
      body: null,
      summary: check.summary,
      createdBy: by,
      createdAt: at,
      updatedAt: at,
      sentBy: null,
      sentAt: null,
      deliveredAt: null,
      failedAt: null,
      failureCode: null,
      attempts: [],
      requestId: null,
      emailCopy: null,
      lifecycle: null,
      occurredAt: check.occurredAt,
      recordedBy: by,
      recordedAt: at,
      respondedAt: null,
      response: null,
      cancelledAt: null,
      cancelledBy: null,
      keys: { create: null, send: null, record: key.key ? { key: key.key, fp } : null },
      history: [
        entry(
          'contact_external_recorded',
          by,
          { channel: check.channel, occurredAt: check.occurredAt, recipientType: routing.recipient.type },
          at,
        ),
      ],
      ...firstRev(req, at),
      policyVersion: CONTACT_POLICY_VERSION,
    };
    let moved = null;
    const stored = unit(() => {
      // Written before the case is asked to move: the evidence provider reads it.
      const advanced = advanceCase(req, room, contacts.create(c), at);
      moved = advanced.moved;
      broadcast('contact_external_recorded', { orgId: room.orgId, roomId: room.id, contactId: c.id });
      return advanced.contact;
    });
    res.status(201).json({
      contact: contactView(stored),
      case: moved ? { from: moved.from, to: moved.to } : { unchanged: true, status: room.room.status },
    });
  });

  // ------------------------------------------------------------- response

  /**
   * The recipient never addresses the Contact; the answer reaches it in the
   * respond route's unit of work, so both commit together.
   */
  ctx.onRequestResponded = ({ request, accept, message = null, by, at = Date.now() }) => {
    if (!request?.contactId) return null;
    const found = contacts.byId(request.contactId);
    if (!found || found.requestId !== request.id || found.status !== 'delivered') return null;
    const kind = accept ? 'accepted' : 'declined';
    const c = contacts.recordResponse(
      found.id,
      { response: { kind, message: message || null, by, at } },
      {
        at,
        revBy: null,
        touch: true,
        bump: true,
        history: [
          entry('contact_responded', { kind: by, name: by === 'guardian' ? 'Guardian' : 'Player' }, { kind }, at),
        ],
      },
    );

    // The sender hears through the respond route; the room's owner and lead
    // scout hear too, if different; nobody else in the organisation does.
    const room = recruitmentReads.cases.byId(c.caseId);
    if (room) {
      for (const uid of new Set([room.ownerUserId, room.room?.leadScoutUserId])) {
        if (!uid || uid === request.userId) continue;
        notify(
          { kind: 'org_user', id: uid },
          'recruitment_room',
          `Recruitment Room — ${room.playerName ?? 'a removed player'}: the ${by} ${kind} your contact.`,
          room.id,
        );
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
      channels: Object.keys(CONTACT_CHANNELS).map((id) => ({
        id,
        label: CONTACT_CHANNELS[id].label,
        external: CONTACT_CHANNELS[id].external,
      })),
      caseStatuses: CONTACT_CASE_STATUSES,
      limits: CONTACT_LIMITS,
      modes: CONTACT_MODES,
      note: "A draft is not a contact. Delivered means the message is in the recipient's ScoutBox Inbox; ScoutBox does not report whether it was read.",
      agentNote:
        "You may ask that the player's own agent be a party as well (\"both\"). Whether that is permitted is decided by the player's relationship, the agent's licence and the player's own choice — and it is decided again when you send. There is no mode that reaches an agent instead of the player.",
    });
  });

  return { contactsOf, byAtThenId };
}
