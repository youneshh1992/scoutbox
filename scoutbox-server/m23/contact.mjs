/**
 * M23 P3 — the Contact engine: pure functions over plain data.
 *
 * A Contact is the club's INTERNAL record of one communication process with
 * a player or, for a minor, with the guardian who owns that player's account.
 * It is not the recruitment lifecycle (the case owns that), not the Inbox
 * (the recipient sees a `db.requests` row) and not a message thread (channels
 * own conversation). It exists so that three facts have an honest home:
 *
 *   a draft is not contact           — it lives here and nowhere the recipient reads
 *   delivery truth is not case truth — delivered / failed / responded are facts about
 *                                       an attempt, never case states
 *   an attested external contact     — a phone call recorded after the fact creates
 *                                       nothing in anyone's Inbox
 *
 * Everything in this file is deterministic and side-effect free so the state
 * machine, the recipient rule and the projections can be property-tested
 * without Express, a database or a session.
 */

import { ROOM_TRANSITIONS } from '../m17/shared.mjs';
import { parseInstant, readInstant } from '../temporal.mjs';

export const CONTACT_POLICY_VERSION = 1;

/** Null prototype: every table below is indexed by data we did not write. */
const table = (o) => Object.freeze(Object.assign(Object.create(null), o));
const has = (t, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(t, k);

// ------------------------------------------------------------------ states

/**
 * The Contact object's own states. NONE of these is a case status (contract §2).
 *
 *   draft      written, nothing left the building
 *   delivered  handed to the in-app transport and durable in the recipient's Inbox
 *   failed     an attempt was made and the transport refused it; the draft survives
 *   responded  the recipient answered (accept / decline, optional short reply)
 *   recorded   an external contact (phone, in person, …) attested by a named person
 *   cancelled  a draft or failed contact withdrawn before it ever reached anyone
 *
 * `queued`, `sent`, `bounced`, `read` are deliberately absent: the only
 * transport this build has is its own durable Inbox, which either holds the
 * row or does not. Inventing intermediate states for a transport that cannot
 * distinguish them would be the "fake delivery state" §22 forbids.
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

/** Where each state may go. Anything not listed is refused. */
export const CONTACT_TRANSITIONS = table({
  draft: ['delivered', 'failed', 'cancelled'],
  failed: ['delivered', 'failed', 'cancelled'],
  delivered: ['responded'],
  responded: [],
  recorded: [],
  cancelled: [],
});

/** States that count as "the recipient could have received it" (contract §3). */
export const CONTACT_EVIDENCE_STATUSES = Object.freeze(['delivered', 'responded', 'recorded']);

// ---------------------------------------------------------------- channels

/**
 * `in_app` is the one transport ScoutBox operates. The rest are channels the
 * club used OUTSIDE ScoutBox and attests to after the fact; they carry no
 * recipient object and no delivery state — the record IS the fact.
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
 * M23 P5.6E — the routing modes a club may ask for. The player is a target in
 * both: `both` adds their agent BESIDE them. There is deliberately no mode that
 * reaches an agent INSTEAD of the player (see `contactRouting` in
 * `m27/integration.mjs` for why).
 */
export const CONTACT_MODES = Object.freeze(['player_only', 'both']);

// ------------------------------------------------------------------ limits

export const CONTACT_LIMITS = Object.freeze({
  subject: 120,
  body: 2000,
  summary: 500,
  replyMessage: 500,
  clientKey: 64,
  /** An external contact may be dated up to 15 minutes in the future — clock skew, not planning. */
  occurredAtSkewMs: 15 * 60 * 1000,
  /** And no more than 180 days in the past — a club records a conversation, not a memory. */
  occurredAtMaxAgeMs: 180 * 24 * 60 * 60 * 1000,
  /** One delivered in-app contact per organisation and player per window, unless answered. */
  cooldownMs: 72 * 60 * 60 * 1000,
  historyPage: 100,
});

/** The case states from which a contact may be created, sent or recorded. */
export const CONTACT_CASE_STATUSES = Object.freeze(['contact_planned', 'contacted']);

// ------------------------------------------------------------ roles/actions

/**
 * Who may do what. Mirrors M17's ranking; `roomCan` in m17/shared.mjs carries
 * the same two actions so the Room's permission surface stays one table.
 *
 *   contact_view   viewer and above — Contact history is club memory
 *   contact_write  room_lead and above — drafting, sending, recording,
 *                  cancelling. The contract (§6) fixes `recordContact` at
 *                  room_lead; a contributor proposes through tasks and comments.
 */
const ROLE_RANK = table({ viewer: 0, contributor: 1, room_lead: 2, recruitment_admin: 3 });
const NEED = table({ contact_view: 0, contact_write: 2 });
export function contactRoleAllows(role, action) {
  if (!has(NEED, action) || !has(ROLE_RANK, role)) return false;
  return ROLE_RANK[role] >= NEED[action];
}

/**
 * Contact-level actions and the states they are legal from.
 *
 * `respond` is performed by the RECIPIENT and carries no club role; it is
 * listed so the transition graph is total and property-testable.
 */
export const CONTACT_ACTIONS = table({
  edit: { from: ['draft', 'failed'], role: 'contact_write' },
  send: { from: ['draft', 'failed'], role: 'contact_write', to: 'delivered' },
  cancel: { from: ['draft', 'failed'], role: 'contact_write', to: 'cancelled' },
  respond: { from: ['delivered'], role: null, to: 'responded' },
});
export const CONTACT_ACTION_NAMES = Object.freeze(Object.keys(CONTACT_ACTIONS));

/**
 * THE validator. One function for every Contact mutation.
 * @returns {{ok:true, to?:string} | {ok:false, error:string, message:string}}
 */
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
 * Shared content is stored INERT: markup removed on write, control characters
 * dropped, Unicode normalised. No renderer — ours or a future one — can be
 * talked into executing it, and a lone surrogate cannot corrupt a snapshot.
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

/**
 * The recipient's optional short reply on a CONTACT-type request. Validated
 * before anything is mutated; only a contact may carry one, and it must be
 * text. Moderation runs at the route, on the cleaned text this returns.
 */
export function validateContactReply(raw, { isContact = true } = {}) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, reply: null };
  if (!isContact || typeof raw !== 'string') {
    return { ok: false, error: 'CONTACT_RESPONSE_INVALID', message: 'A reply must be text, and only a contact can carry one.' };
  }
  const reply = plainShared(raw, CONTACT_LIMITS.replyMessage);
  return { ok: true, reply: reply || null };
}

/** A client key: short, opaque, text. Anything else is not a key. */
export function normaliseClientKey(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, key: null };
  if (typeof raw !== 'string') return { ok: false, error: 'CONTACT_CLIENT_KEY_INVALID', message: 'clientKey must be text.' };
  const k = raw.trim();
  if (!k || k.length > CONTACT_LIMITS.clientKey) return { ok: false, error: 'CONTACT_CLIENT_KEY_INVALID', message: 'clientKey must be 1–64 characters.' };
  return { ok: true, key: k };
}

// -------------------------------------------------------------- recipient

/**
 * Derive who a contact for this case may reach. The client never names the
 * recipient: this is computed from the live player, the live organisation,
 * the live guardian records and the clock — and it is re-run on every
 * mutation, not only when the draft was written (§9, §13, §14).
 *
 * @param {object} p
 * @param {object} p.player     live player record (may be undefined)
 * @param {object} p.org        live organisation
 * @param {object[]} p.guardians live guardian records
 * @param {function} p.isAdult  canonical age rule
 * @param {function} p.visibleToOrg canonical visibility wall
 * @param {function} p.isBlocked   canonical block relation
 * @param {Date} [p.now]
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
  // honest answer to "which guardian". A record that does not list the child,
  // a child with no record, two records that disagree with the player's own
  // link, or a malformed record all FAIL CLOSED. There is no direct fallback.
  //
  // A valid route is a guardian record that (a) exists, (b) lists this child,
  // (c) has passed the identity and disclaimer gates. A co-guardian who has
  // not yet verified is not a route. Two verified owners and no primary link
  // to choose between them is ambiguity, and ambiguity fails closed too.
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

/**
 * Validate an attested external contact (§36–§38). The recipient
 * classification the club states must equal the one the platform derives:
 * recording "I phoned the player" about a minor is refused, not corrected.
 */
export function validateExternalRecord({ channel, occurredAt, summary, recipientType } = {}, { now = Date.now(), derivedRecipientType } = {}) {
  if (!has(CONTACT_CHANNELS, channel) || !CONTACT_CHANNELS[channel].external) {
    return { ok: false, error: 'CONTACT_CHANNEL_INVALID', message: `Channel must be one of ${EXTERNAL_CHANNELS.join(', ')}.`, allowed: EXTERNAL_CHANNELS };
  }
  // M23 P5.7 (T-6): one instant parser. A bare local time (`2026-03-01T10:00`)
  // used to be read in whatever zone the server runs in, `02/03/2026` was read
  // as an American date, and `2026-02-30T10:00Z` as 2 March. All refused now.
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

/**
 * Deterministic anti-spam (§54–§55): at most one DELIVERED in-app contact per
 * organisation and player within `cooldownMs`, unless that contact has been
 * answered. Server-enforced, clock-injected, no randomness.
 */
export function cooldownFor(contacts, { orgId, playerId, now = Date.now(), exceptId = null }) {
  // M23 P5.7 (T-13): a FINITE delivery instant. `typeof Infinity === 'number'`
  // let a corrupt `deliveredAt: Infinity` cool the pair down for ever.
  const recent = contacts.filter((c) => c && c.orgId === orgId && c.playerId === playerId && c.id !== exceptId
    && c.channel === 'in_app' && c.status === 'delivered' && readInstant(c.deliveredAt) !== null
    && now - c.deliveredAt < CONTACT_LIMITS.cooldownMs);
  if (recent.length === 0) return null;
  const latest = Math.max(...recent.map((c) => c.deliveredAt));
  return { retryAt: latest + CONTACT_LIMITS.cooldownMs, blockingContactId: recent.find((c) => c.deliveredAt === latest)?.id ?? null };
}

// ------------------------------------------------------------ idempotency

/** A stable fingerprint of the parts of a request that make it "the same request". */
export function payloadFingerprint(parts) {
  return JSON.stringify(parts, Object.keys(parts).sort());
}

// ------------------------------------------------------------ projections

const HISTORY_SEQ = (id) => { const n = Number(String(id ?? '').split('-').pop()); return Number.isFinite(n) ? n : 0; };

/** Time, then the monotonic id part — two entries in one millisecond never swap. */
export const byAtThenId = (a, b) => (a.at - b.at) || (HISTORY_SEQ(a.id) - HISTORY_SEQ(b.id));

/** Entries a person can read. Implementation-level names are translated by the client; no keys, no fingerprints. */
export function contactHistoryView(contact) {
  return (contact.history ?? []).slice().sort(byAtThenId).map((h) => ({
    id: h.id, at: h.at, action: h.action,
    by: h.by ? { name: h.by.name ?? null, kind: h.by.kind ?? null } : null,
    detail: h.detail ?? null,
  }));
}

/**
 * The club's view of one Contact. The club wrote the body, so it sees it;
 * the recipient's reply is the one thing the recipient authored, and it is
 * shown because it was addressed to the club. Keys and fingerprints stay out.
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
    // M23 P5.6E — what the club asked for, and what was actually routed. The
    // snapshot carries roles and ids only: the agent's own name is not the club's
    // to learn from here, and the club already has the agent-presence projection
    // for that, gated on the player's own choice.
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

/** The journey milestone: ids, states and times. Never a body, never a summary, never a reply. */
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

/** Can a case at this status start (or continue) a contact process? */
export function caseAcceptsContact(status) {
  return CONTACT_CASE_STATUSES.includes(status) && !!ROOM_TRANSITIONS[status];
}

/**
 * Structural corruption checks for one stored record. Reports, never repairs
 * (§143). A corrupt record is excluded from projections and named in the log;
 * nothing is fabricated to fill the gap.
 */
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
  // M23 P5.6E. An unknown mode and a malformed snapshot both mean the record
  // cannot say who it reached, which is exactly what this store is for.
  if (c.contactMode !== undefined && c.contactMode !== null && !CONTACT_MODES.includes(c.contactMode)) problems.push('contact_mode_unknown');
  if (c.routingSnapshot !== undefined && c.routingSnapshot !== null) {
    const r = c.routingSnapshot;
    if (typeof r !== 'object' || Array.isArray(r) || !Number.isFinite(r.at) || !CONTACT_MODES.includes(r.mode)) problems.push('routing_snapshot_malformed');
    else if (r.agent !== null && r.agent !== undefined && typeof r.agent?.agentUserId !== 'string') problems.push('routing_snapshot_malformed');
    // A routed agent on a contact that never left the building is a
    // contradiction: only a send writes a snapshot.
    else if (r.agent && !['delivered', 'responded'].includes(c.status)) problems.push('routing_snapshot_unsent');
  }
  if (c.history !== undefined && !Array.isArray(c.history)) problems.push('history_malformed');
  if (['delivered', 'responded'].includes(c.status) && !Number.isFinite(c.deliveredAt)) problems.push('timestamp_malformed');
  if (c.status === 'recorded' && !Number.isFinite(c.occurredAt)) problems.push('timestamp_malformed');
  return problems;
}
