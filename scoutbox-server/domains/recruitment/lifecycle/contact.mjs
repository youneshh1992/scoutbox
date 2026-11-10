/**
 * The Contact engine: pure functions over plain data. A Contact is the club's
 * internal record of one communication with a player or, for a minor, their
 * guardian. It is not the case lifecycle, the recipient's Inbox row or a
 * message thread. A draft is not contact; delivered, failed and responded are
 * facts about an attempt, never case states; an attested external contact
 * creates nothing in anyone's Inbox.
 */

import { ROOM_TRANSITIONS } from '../rooms/shared.mjs';
import { parseInstant, readInstant } from '../../../temporal.mjs';
import { normaliseClientKey as platformClientKey, payloadFingerprint, CLIENT_KEY_MAX } from '../../platform/idempotency.mjs';

export const CONTACT_POLICY_VERSION = 1;

/** Null prototype: these tables are indexed by data we did not write. */
const table = (o) => Object.freeze(Object.assign(Object.create(null), o));
const has = (t, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(t, k);

// ------------------------------------------------------------------ states

/**
 * None of these is a case status.
 *
 *   draft      written, nothing left the building
 *   delivered  handed to the in-app transport and durable in the recipient's Inbox
 *   failed     the transport refused an attempt; the draft survives
 *   responded  the recipient answered (accept / decline, optional short reply)
 *   recorded   an external contact (phone, in person, …) attested by a named person
 *   cancelled  a draft or failed contact withdrawn before it reached anyone
 *
 * No `queued`, `sent`, `bounced` or `read`: the only transport is the durable
 * Inbox, which either holds the row or does not.
 */
export const CONTACT_STATUSES = Object.freeze(['draft', 'delivered', 'failed', 'responded', 'recorded', 'cancelled']);

export const CONTACT_STATUS_LABELS = table({
  draft: 'Draft',
  delivered: 'Delivered',
  failed: 'Send failed',
  responded: 'Response received',
  recorded: 'Recorded (external)',
  cancelled: 'Cancelled',
});

export const CONTACT_TRANSITIONS = table({
  draft: ['delivered', 'failed', 'cancelled'],
  failed: ['delivered', 'failed', 'cancelled'],
  delivered: ['responded'],
  responded: [],
  recorded: [],
  cancelled: [],
});

/** States that count as "the recipient could have received it". */
export const CONTACT_EVIDENCE_STATUSES = Object.freeze(['delivered', 'responded', 'recorded']);

// ---------------------------------------------------------------- channels

/**
 * `in_app` is the one transport ScoutBox operates. The rest are channels used
 * outside ScoutBox and attested after the fact: no recipient object, no delivery state.
 */
export const CONTACT_CHANNELS = table({
  in_app: { external: false, label: 'ScoutBox message' },
  phone: { external: true, label: 'Telephone' },
  in_person: { external: true, label: 'In person' },
  email_external: { external: true, label: 'Email (outside ScoutBox)' },
  agent: { external: true, label: 'Via agent or guardian conversation' },
  other: { external: true, label: 'Other' },
});
export const EXTERNAL_CHANNELS = Object.freeze(Object.keys(CONTACT_CHANNELS).filter((c) => CONTACT_CHANNELS[c].external));

export const RESPONSE_KINDS = Object.freeze(['accepted', 'declined']);

/**
 * `both` adds the player's agent beside them. No mode reaches an agent instead
 * of the player (see `contactRouting` in domains/agents/integration/integration.mjs).
 */
export const CONTACT_MODES = Object.freeze(['player_only', 'both']);

// ------------------------------------------------------------------ limits

export const CONTACT_LIMITS = Object.freeze({
  subject: 120,
  body: 2000,
  summary: 500,
  replyMessage: 500,
  clientKey: CLIENT_KEY_MAX,
  /** Up to 15 minutes in the future: clock skew, not planning. */
  occurredAtSkewMs: 15 * 60 * 1000,
  /** No more than 180 days in the past. */
  occurredAtMaxAgeMs: 180 * 24 * 60 * 60 * 1000,
  /** One delivered in-app contact per organisation and player per window, unless answered. */
  cooldownMs: 72 * 60 * 60 * 1000,
  historyPage: 100,
});

/** The case states from which a contact may be created, sent or recorded. */
export const CONTACT_CASE_STATUSES = Object.freeze(['contact_planned', 'contacted']);

// ------------------------------------------------------------ roles/actions

/**
 * `roomCan` in rooms/shared.mjs carries the same two actions. contact_write is
 * room_lead and above; a contributor proposes through tasks and comments.
 */
const ROLE_RANK = table({ viewer: 0, contributor: 1, room_lead: 2, recruitment_admin: 3 });
const NEED = table({ contact_view: 0, contact_write: 2 });
export function contactRoleAllows(role, action) {
  if (!has(NEED, action) || !has(ROLE_RANK, role)) return false;
  return ROLE_RANK[role] >= NEED[action];
}

/** `respond` is the recipient's and carries no club role; it is listed so the transition graph is total. */
export const CONTACT_ACTIONS = table({
  edit: { from: ['draft', 'failed'], role: 'contact_write' },
  send: { from: ['draft', 'failed'], role: 'contact_write', to: 'delivered' },
  cancel: { from: ['draft', 'failed'], role: 'contact_write', to: 'cancelled' },
  respond: { from: ['delivered'], role: null, to: 'responded' },
});
export const CONTACT_ACTION_NAMES = Object.freeze(Object.keys(CONTACT_ACTIONS));

/** @returns {{ok:true, to?:string} | {ok:false, error:string, message:string}} */
export function canContactAction(contact, action, { role = null } = {}) {
  if (!has(CONTACT_ACTIONS, action)) {
    return { ok: false, error: 'CONTACT_ACTION_UNKNOWN', message: 'No such contact action.' };
  }
  const def = CONTACT_ACTIONS[action];
  if (!contact || !CONTACT_STATUSES.includes(contact.status)) {
    return { ok: false, error: 'CONTACT_STATE_UNKNOWN', message: 'This contact is in a state this build does not recognise.' };
  }
  if (def.role && !contactRoleAllows(role, def.role)) {
    return { ok: false, error: 'CONTACT_NOT_PERMITTED', message: 'Your role cannot do this with a contact.' };
  }
  if (!def.from.includes(contact.status)) {
    if (contact.status === 'delivered' && action === 'send') {
      return { ok: false, error: 'CONTACT_ALREADY_SENT', message: 'This contact has already been delivered.' };
    }
    return { ok: false, error: 'CONTACT_INVALID_STATE', message: `A contact that is ${CONTACT_STATUS_LABELS[contact.status].toLowerCase()} cannot be ${action === 'edit' ? 'edited' : action === 'cancel' ? 'cancelled' : action + 'ed'}.` };
  }
  if (def.to && !CONTACT_TRANSITIONS[contact.status].includes(def.to)) {
    return { ok: false, error: 'CONTACT_INVALID_STATE', message: 'That move is not possible from here.' };
  }
  return { ok: true, to: def.to ?? contact.status };
}

// ---------------------------------------------------------------- content

/**
 * Shared content is stored inert: markup removed, control characters dropped,
 * Unicode normalised, so no renderer can execute it and a lone surrogate cannot
 * corrupt a snapshot.
 */
export function plainShared(value, max) {
  if (value == null) return '';
  if (typeof value !== 'string') return null; // not text at all — the caller refuses
  let s = value.normalize('NFC');
  s = s.replace(/<[^>]*>/g, '').replace(/[<>]/g, '');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  return s.trim().slice(0, max);
}

export function validateContactContent({ subject, body } = {}, { requireBody = true } = {}) {
  const s = plainShared(subject, CONTACT_LIMITS.subject);
  const b = plainShared(body, CONTACT_LIMITS.body);
  if (s === null || b === null) {
    return { ok: false, error: 'CONTACT_CONTENT_INVALID', message: 'Subject and message must be text.' };
  }
  if (typeof body === 'string' && body.length > CONTACT_LIMITS.body * 4) {
    return { ok: false, error: 'CONTACT_CONTENT_TOO_LONG', message: `Keep the message under ${CONTACT_LIMITS.body} characters.` };
  }
  if (requireBody && !b) {
    return { ok: false, error: 'CONTACT_CONTENT_INVALID', message: 'Write the message the player or guardian will read.' };
  }
  return { ok: true, subject: s || null, body: b };
}

/** Only a contact-type request may carry a reply. Moderation runs at the route, on the cleaned text. */
export function validateContactReply(raw, { isContact = true } = {}) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, reply: null };
  if (!isContact || typeof raw !== 'string') {
    return { ok: false, error: 'CONTACT_RESPONSE_INVALID', message: 'A reply must be text, and only a contact can carry one.' };
  }
  const reply = plainShared(raw, CONTACT_LIMITS.replyMessage);
  return { ok: true, reply: reply || null };
}

export const normaliseClientKey = (raw) => platformClientKey(raw, 'CONTACT_CLIENT_KEY_INVALID');

// -------------------------------------------------------------- recipient

/**
 * The client never names the recipient: it is derived from the live player,
 * organisation, guardian records and clock, and re-derived on every mutation.
 */
export function resolveContactRecipient({ player, org, guardians = [], isAdult, visibleToOrg, isBlocked, now = new Date() }) {
  if (!player || player.deletedAt || player.removedAt) {
    return { ok: false, error: 'CONTACT_RECIPIENT_UNAVAILABLE', message: 'This player is not available to contact.' };
  }
  if (isBlocked(player.id, org.id)) {
    return { ok: false, error: 'CONTACT_BLOCKED', message: 'This player (or their guardian) has blocked your organisation.' };
  }
  if (!visibleToOrg(player, org)) {
    return { ok: false, error: 'CONTACT_RECIPIENT_UNAVAILABLE', message: 'This player is not available to your organisation under the standing rules.' };
  }
  if (isAdult(player, now)) {
    return { ok: true, recipient: { type: 'player', playerId: player.id, guardianId: null, minor: false } };
  }
  // A minor: the guardian is the recipient, and there must be exactly one
  // answer to "which guardian". The guardian must list this child and have
  // passed the identity and disclaimer gates; an unverified co-guardian is not
  // a route. Anything else, including two verified owners with no primary link
  // between them, fails closed. There is no direct fallback.
  const owners = guardians.filter((g) => g && typeof g.id === 'string' && Array.isArray(g.childIds)
    && g.childIds.includes(player.id) && g.idVerified === true && g.disclaimerAccepted === true && !g.removedAt);
  let guardian = null;
  if (owners.length === 1) guardian = owners[0];
  else if (owners.length > 1) guardian = owners.find((g) => g.id === player.guardianId) ?? null;
  if (!guardian) {
    return { ok: false, error: 'CONTACT_GUARDIAN_REQUIRED', message: 'This player is under the age of majority and no valid guardian route exists. Contact cannot proceed.' };
  }
  return { ok: true, recipient: { type: 'guardian', playerId: player.id, guardianId: guardian.id, minor: true } };
}

// ----------------------------------------------------------- external record

/** The recipient type the club states must equal the derived one: "I phoned the player" about a minor is refused, not corrected. */
export function validateExternalRecord({ channel, occurredAt, summary, recipientType } = {}, { now = Date.now(), derivedRecipientType } = {}) {
  if (!has(CONTACT_CHANNELS, channel) || !CONTACT_CHANNELS[channel].external) {
    return { ok: false, error: 'CONTACT_CHANNEL_INVALID', message: `Channel must be one of ${EXTERNAL_CHANNELS.join(', ')}.`, allowed: EXTERNAL_CHANNELS };
  }
  // Refuses a bare local time (zone-dependent), `02/03/2026` (ambiguous) and `2026-02-30T10:00Z` (not a day).
  const parsed = parseInstant(occurredAt);
  if (!parsed.ok) {
    return { ok: false, error: 'CONTACT_OCCURRED_AT_INVALID', message: 'occurredAt must be a date and time: ISO 8601 with an explicit offset or Z, or a millisecond timestamp.' };
  }
  const ts = parsed.ms;
  if (ts > now + CONTACT_LIMITS.occurredAtSkewMs) {
    return { ok: false, error: 'CONTACT_OCCURRED_AT_INVALID', message: 'A contact cannot be recorded before it has happened.' };
  }
  if (ts < now - CONTACT_LIMITS.occurredAtMaxAgeMs) {
    return { ok: false, error: 'CONTACT_OCCURRED_AT_INVALID', message: 'A contact this old cannot be recorded as recruitment evidence.' };
  }
  if (recipientType !== undefined && recipientType !== derivedRecipientType) {
    return { ok: false, error: 'CONTACT_RECIPIENT_MISMATCH', message: derivedRecipientType === 'guardian' ? 'This player is under the age of majority: a recorded contact must be with the guardian.' : 'This player is an adult: the recorded contact is with the player.' };
  }
  const s = plainShared(summary, CONTACT_LIMITS.summary);
  if (s === null) return { ok: false, error: 'CONTACT_CONTENT_INVALID', message: 'The summary must be text.' };
  return { ok: true, channel, occurredAt: ts, summary: s || null };
}

// ------------------------------------------------------------- cooldown

/** At most one delivered in-app contact per organisation and player within `cooldownMs`, unless answered. */
export function cooldownFor(contacts, { orgId, playerId, now = Date.now(), exceptId = null }) {
  // `typeof Infinity === 'number'`, and a corrupt `deliveredAt: Infinity` would cool the pair down for ever.
  const recent = contacts.filter((c) => c && c.orgId === orgId && c.playerId === playerId && c.id !== exceptId
    && c.channel === 'in_app' && c.status === 'delivered' && readInstant(c.deliveredAt) !== null
    && now - c.deliveredAt < CONTACT_LIMITS.cooldownMs);
  if (recent.length === 0) return null;
  const latest = Math.max(...recent.map((c) => c.deliveredAt));
  return { retryAt: latest + CONTACT_LIMITS.cooldownMs, blockingContactId: recent.find((c) => c.deliveredAt === latest)?.id ?? null };
}

// ------------------------------------------------------------ idempotency

export { payloadFingerprint };

// ------------------------------------------------------------ projections

const HISTORY_SEQ = (id) => { const n = Number(String(id ?? '').split('-').pop()); return Number.isFinite(n) ? n : 0; };

/** Time, then the monotonic id part, so two entries in one millisecond never swap. */
export const byAtThenId = (a, b) => (a.at - b.at) || (HISTORY_SEQ(a.id) - HISTORY_SEQ(b.id));

/** Implementation-level names are translated by the client; no keys, no fingerprints. */
export function contactHistoryView(contact) {
  return (contact.history ?? []).slice().sort(byAtThenId).map((h) => ({
    id: h.id, at: h.at, action: h.action,
    by: h.by ? { name: h.by.name ?? null, kind: h.by.kind ?? null } : null,
    detail: h.detail ?? null,
  }));
}

/**
 * The club wrote the body, so it sees it; the reply is shown because it was
 * addressed to the club. Keys and fingerprints stay out.
 */
export function contactView(c) {
  return {
    id: c.id,
    caseId: c.caseId,
    playerId: c.playerId,
    status: c.status,
    statusLabel: CONTACT_STATUS_LABELS[c.status] ?? c.status,
    channel: c.channel,
    channelLabel: CONTACT_CHANNELS[c.channel]?.label ?? c.channel,
    external: !!CONTACT_CHANNELS[c.channel]?.external,
    recipient: c.recipient ? { type: c.recipient.type, minor: !!c.recipient.minor } : null,
    // The snapshot carries roles and ids only: the agent's name is not the
    // club's to learn here; the agent-presence projection covers that, gated on the player's choice.
    contactMode: c.contactMode ?? 'player_only',
    routedToAgent: !!c.routingSnapshot?.agent,
    routedAt: c.routingSnapshot?.at ?? null,
    subject: c.subject ?? null,
    body: c.body ?? null,
    summary: c.summary ?? null,
    createdBy: c.createdBy ? { name: c.createdBy.name } : null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    sentBy: c.sentBy ? { name: c.sentBy.name } : null,
    sentAt: c.sentAt ?? null,
    deliveredAt: c.deliveredAt ?? null,
    failedAt: c.failedAt ?? null,
    failureCode: c.failureCode ?? null,
    attempts: (c.attempts ?? []).length,
    occurredAt: c.occurredAt ?? null,
    recordedBy: c.recordedBy ? { name: c.recordedBy.name } : null,
    recordedAt: c.recordedAt ?? null,
    respondedAt: c.respondedAt ?? null,
    response: c.response ? { kind: c.response.kind, message: c.response.message ?? null, by: c.response.by, at: c.response.at } : null,
    emailCopy: c.emailCopy ?? null,
    lifecycle: c.lifecycle ?? null,
    cancelledAt: c.cancelledAt ?? null,
    rev: c.rev ?? 1,
    revAt: c.revAt ?? null,
    revBy: c.revBy?.name ?? null,
    history: contactHistoryView(c),
    transportNote: c.channel === 'in_app'
      ? 'Delivered means the message is in the recipient\'s ScoutBox Inbox. ScoutBox does not track whether it was read.'
      : 'Recorded by a named member of staff. ScoutBox did not observe this contact.',
    policyVersion: CONTACT_POLICY_VERSION,
  };
}

/** Never a body, a summary or a reply. */
export function contactMilestone(c) {
  return {
    id: c.id,
    status: c.status,
    channel: c.channel,
    recipientType: c.recipient?.type ?? null,
    routedToAgent: !!c.routingSnapshot?.agent,
    initiatedAt: c.status === 'recorded' ? (c.occurredAt ?? c.recordedAt ?? null) : (c.deliveredAt ?? null),
    respondedAt: c.respondedAt ?? null,
    responseKind: c.response?.kind ?? null,
  };
}

export function caseAcceptsContact(status) {
  return CONTACT_CASE_STATUSES.includes(status) && !!ROOM_TRANSITIONS[status];
}

/** Reports, never repairs: a corrupt record is excluded from projections and named in the log. */
export function contactIntegrity(c, { orgId = null, caseId = null } = {}) {
  const problems = [];
  if (!c || typeof c !== 'object') return ['not_an_object'];
  if (typeof c.id !== 'string') problems.push('id_missing');
  if (!CONTACT_STATUSES.includes(c.status)) problems.push('status_unknown');
  if (!has(CONTACT_CHANNELS, c.channel)) problems.push('channel_unknown');
  if (orgId && c.orgId !== orgId) problems.push('org_mismatch');
  if (caseId && c.caseId !== caseId) problems.push('case_mismatch');
  if (typeof c.playerId !== 'string') problems.push('player_missing');
  if (['delivered', 'responded', 'recorded'].includes(c.status) && !c.recipient?.type) problems.push('recipient_missing');
  // Either means the record cannot say who it reached, which is what this store is for.
  if (c.contactMode !== undefined && c.contactMode !== null && !CONTACT_MODES.includes(c.contactMode)) problems.push('contact_mode_unknown');
  if (c.routingSnapshot !== undefined && c.routingSnapshot !== null) {
    const r = c.routingSnapshot;
    if (typeof r !== 'object' || Array.isArray(r) || !Number.isFinite(r.at) || !CONTACT_MODES.includes(r.mode)) problems.push('routing_snapshot_malformed');
    else if (r.agent !== null && r.agent !== undefined && typeof r.agent?.agentUserId !== 'string') problems.push('routing_snapshot_malformed');
    // Only a send writes a snapshot.
    else if (r.agent && !['delivered', 'responded'].includes(c.status)) problems.push('routing_snapshot_unsent');
  }
  if (c.history !== undefined && !Array.isArray(c.history)) problems.push('history_malformed');
  if (['delivered', 'responded'].includes(c.status) && !Number.isFinite(c.deliveredAt)) problems.push('timestamp_malformed');
  if (c.status === 'recorded' && !Number.isFinite(c.occurredAt)) problems.push('timestamp_malformed');
  return problems;
}
