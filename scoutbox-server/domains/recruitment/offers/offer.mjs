/**
 * The Offer domain: pure functions over one stored Offer and a clock.
 *
 * A recruitment decision, an offer, an offer acceptance and a signing are four different things: an accepted
 * Offer is not a signing. An issued revision is immutable; changed terms are a new revision, and an answer
 * names one exact issued revision. Responses record who answered (a guardian is never written as the player).
 *
 * `effectiveRevisionStatus` reads an issued revision whose expiry has passed, or cannot be read, as EXPIRED
 * without any job having run, so access never depends on a materialised status.
 */

import * as v from 'valibot';
import { parseInstant, isExpiredAt, readInstant, isAbsent, DAY_MS } from '../../../temporal.mjs';
import { ID_MAX, dayOrBlank, oneOf, parseInput, requiredText } from '../../platform/schemas.mjs';
import {
  normaliseClientKey as platformClientKey,
  payloadFingerprint,
  CLIENT_KEY_MAX,
} from '../../platform/idempotency.mjs';

export const OFFER_POLICY_VERSION = 1;

const table = (o) => Object.freeze(Object.assign(Object.create(null), o));
const has = (t, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(t, k);

// ------------------------------------------------------------------ vocabulary

/** `viewed` is a read receipt, not a status. */
export const OFFER_STATUSES = Object.freeze([
  'DRAFT',
  'ISSUED',
  'ACCEPTED',
  'DECLINED',
  'WITHDRAWN',
  'EXPIRED',
  'SUPERSEDED',
]);
export const OFFER_TERMINAL_STATUSES = Object.freeze(['ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED', 'SUPERSEDED']);

export const OFFER_STATUS_LABELS = table({
  DRAFT: 'Draft — not issued',
  ISSUED: 'Issued — awaiting response',
  ACCEPTED: 'Offer accepted — signing pending',
  DECLINED: 'Declined by the recipient',
  WITHDRAWN: 'Withdrawn by the club',
  EXPIRED: 'Expired',
  SUPERSEDED: 'Superseded by a later revision',
});

/** No edge out of ACCEPTED: a later contract workflow or an explicit restart owns that. */
export const OFFER_REVISION_TRANSITIONS = table({
  DRAFT: ['ISSUED', 'WITHDRAWN'],
  ISSUED: ['ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED', 'SUPERSEDED'],
  ACCEPTED: [],
  DECLINED: [],
  WITHDRAWN: [],
  EXPIRED: [],
  SUPERSEDED: [],
});

/**
 * A transfer or loan needs a releasing club and club-to-club terms this build cannot model, so only direct
 * recruitment is supported.
 */
export const OFFER_TYPES = Object.freeze(['direct_recruitment']);

export const OFFER_RESPONSE_TYPES = Object.freeze(['accepted', 'declined']);
export const OFFER_RESPONSE_ACTORS = Object.freeze(['player', 'guardian']);

export const OFFER_LIMITS = Object.freeze({
  role: 80,
  squad: 80,
  conditions: 1000,
  recipientMessage: 2000,
  internalNote: 2000,
  withdrawReason: 400,
  declineReason: 400,
  documentLabel: 120,
  documents: 10,
  revisions: 20,
  clientKey: CLIENT_KEY_MAX,
  minExpiryMs: 60 * 60 * 1000,
  maxExpiryMs: 180 * DAY_MS,
  historyPage: 200,
});

/**
 * No jurisdiction's legal policy for an Offer to a minor is encoded yet, so the pathway is closed everywhere:
 * an Offer whose recipient resolves to a guardian is refused at issue. Opening one is a change to this table.
 */
export const MINOR_OFFER_PATHWAY_ENABLED = Object.freeze({
  GB: false,
  ENG: false,
  INT: false,
  USA: false,
  DEFAULT: false,
});
export const minorOfferPathwayOpen = (jurisdiction, policy = MINOR_OFFER_PATHWAY_ENABLED) =>
  jurisdiction && has(policy, jurisdiction) ? policy[jurisdiction] === true : policy.DEFAULT === true;

// ------------------------------------------------------------------ keys

export const normaliseOfferClientKey = (raw) => platformClientKey(raw, 'OFFER_CLIENT_KEY_INVALID');

export { payloadFingerprint };

// ------------------------------------------------------------------ input

// Offer text is measured after cleanText strips control characters, so the schemas check only that it is text.
const offerText = v.nullish(v.string());

/**
 * Deliberately narrow terms. There is no compensation field, and nothing here is a legal clause or a
 * contract. `startDate` is required at issue; days are calendar days, not instants.
 */
export const OfferTerms = v.strictObject({
  offerType: v.nullish(oneOf(OFFER_TYPES)),
  role: offerText,
  squad: offerText,
  conditions: offerText,
  startDate: v.nullish(dayOrBlank),
  endDate: v.nullish(dayOrBlank),
});
export const OfferDocuments = v.pipe(
  v.array(v.strictObject({ evidenceId: requiredText(ID_MAX), label: offerText })),
  v.maxLength(OFFER_LIMITS.documents),
);
/** The fields every Offer write may carry; `clientKey` and `expiresAt` are judged by their own rules below. */
export const OFFER_CONTENT_FIELDS = {
  terms: v.nullish(OfferTerms),
  recipientMessage: offerText,
  internalNote: offerText,
  expiresAt: v.optional(v.unknown()),
  documents: v.optional(OfferDocuments),
};

/** Shape refusals carry the Offer contract's codes. */
export const OFFER_INPUT_CODES = Object.freeze({
  codes: { FIELD_INVALID: 'OFFER_INPUT_INVALID' },
  fieldCodes: {
    'terms.*': 'OFFER_TERMS_INVALID',
    'documents.*': 'OFFER_DOCUMENT_INVALID',
    expectedRev: 'OFFER_REV_REQUIRED',
    expectedVersion: 'OFFER_REV_REQUIRED',
  },
});

const refusal = (error, field, problem, message, extra = {}) => ({
  ok: false,
  error,
  field,
  problem,
  message,
  ...extra,
});

function cleanText(raw, max, { oneLine = false } = {}) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  // eslint-disable-next-line no-control-regex
  let s = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  // Directional and zero-width controls are stripped: they let a message read differently from what was
  // typed (bidi spoofing).
  s = s.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '');
  if (oneLine) s = s.replace(/[\r\n]+/g, ' ');
  s = s.trim();
  if (s.length > max) return { ok: false };
  return { ok: true, value: s || null };
}
/** The cleaned text of each `[field, raw, max, oneLine]`, or the refusal for the first that is too long. */
function cleanAll(error, parts) {
  const out = {};
  for (const [field, raw, max, oneLine] of parts) {
    const c = cleanText(raw, max, { oneLine });
    if (!c.ok) return refusal(error, field, 'too_long', `${field} must be at most ${max} characters.`, { max });
    out[field.split('.').at(-1)] = c.value;
  }
  return { ok: true, values: out };
}

export function validateTerms(raw, { requireComplete = false } = {}) {
  // An object schema would take an array as an object with no fields.
  if (Array.isArray(raw)) return refusal('OFFER_TERMS_INVALID', 'terms', 'not_object', 'terms must be an object.');
  const parsed = parseInput(v.strictObject({ terms: v.nullish(OfferTerms) }), { terms: raw }, OFFER_INPUT_CODES);
  if (!parsed.ok) return parsed;
  const t = parsed.value.terms ?? {};
  const L = OFFER_LIMITS;
  const text = cleanAll('OFFER_TERMS_INVALID', [
    ['terms.role', t.role, L.role, true],
    ['terms.squad', t.squad, L.squad, true],
    ['terms.conditions', t.conditions, L.conditions, false],
  ]);
  if (!text.ok) return text;
  const startDate = t.startDate || null;
  const endDate = t.endDate || null;
  if (startDate && endDate && !(startDate < endDate))
    return refusal('OFFER_TERMS_INVALID', 'terms.endDate', 'invalid', 'The end date must be after the start date.');
  if (requireComplete && !startDate)
    return refusal(
      'OFFER_TERMS_INVALID',
      'terms.startDate',
      'required',
      'An issued Offer names the day it would start.',
    );
  return {
    ok: true,
    terms: { offerType: t.offerType ?? 'direct_recruitment', ...text.values, startDate, endDate },
  };
}

export function validateMessages({ recipientMessage, internalNote } = {}) {
  const parsed = parseInput(
    v.strictObject({ recipientMessage: offerText, internalNote: offerText }),
    { recipientMessage, internalNote },
    OFFER_INPUT_CODES,
  );
  if (!parsed.ok) return parsed;
  const text = cleanAll('OFFER_INPUT_INVALID', [
    ['recipientMessage', recipientMessage, OFFER_LIMITS.recipientMessage, false],
    ['internalNote', internalNote, OFFER_LIMITS.internalNote, false],
  ]);
  if (!text.ok) return text;
  return { ok: true, recipientMessage: text.values.recipientMessage, internalNote: text.values.internalNote };
}

/** An instant with an explicit offset, or milliseconds; never the client's clock. */
export function validateExpiry(raw, { now, required = false } = {}) {
  const bad = (problem, message, extra = {}) => refusal('OFFER_EXPIRY_INVALID', 'expiresAt', problem, message, extra);
  if (isAbsent(raw)) return required ? bad('required', 'An issued Offer needs an expiry.') : { ok: true, ms: null };
  const p = parseInstant(raw);
  if (!p.ok)
    return bad(
      'not_a_timestamp',
      `expiresAt must be an ISO 8601 date-time with an explicit offset or Z, or a millisecond timestamp (${p.why}).`,
      { expected: p.expected },
    );
  if (Number.isFinite(now)) {
    if (p.ms < now + OFFER_LIMITS.minExpiryMs)
      return bad('too_small', 'An Offer must stay open for at least an hour after it is issued.', {
        min: now + OFFER_LIMITS.minExpiryMs,
      });
    if (p.ms > now + OFFER_LIMITS.maxExpiryMs)
      return bad('too_large', 'An Offer cannot stay open for more than 180 days.', {
        max: now + OFFER_LIMITS.maxExpiryMs,
      });
  }
  return { ok: true, ms: p.ms };
}

/** References to the evidence vault by id, with a label; no bytes, no paths. */
export function validateDocumentRefs(raw) {
  if (raw === undefined) return { ok: true, documents: undefined };
  const parsed = parseInput(v.strictObject({ documents: OfferDocuments }), { documents: raw }, OFFER_INPUT_CODES);
  if (!parsed.ok) return parsed;
  const out = [];
  for (const [i, d] of parsed.value.documents.entries()) {
    const docId = d.evidenceId.trim();
    if (out.some((x) => x.evidenceId === docId))
      return refusal('OFFER_DOCUMENT_INVALID', `documents[${i}].evidenceId`, 'invalid', 'A document appears twice.');
    const label = cleanAll('OFFER_DOCUMENT_INVALID', [
      [`documents[${i}].label`, d.label, OFFER_LIMITS.documentLabel, true],
    ]);
    if (!label.ok) return label;
    out.push({ evidenceId: docId, label: label.values.label });
  }
  return { ok: true, documents: out };
}

// ------------------------------------------------------------------ status

/** Stored ISSUED with a passed or unreadable expiry reads EXPIRED; an unknown stored status reads as null. */
export function effectiveRevisionStatus(rev, now) {
  if (!rev || !OFFER_STATUSES.includes(rev.status)) return null;
  if (rev.status === 'ISSUED' && isExpiredAt(rev.expiresAt ?? NaN, now)) return 'EXPIRED';
  return rev.status;
}

export const currentRevision = (offer) =>
  (offer?.revisions ?? []).find((r) => r && r.id === offer.currentRevisionId) ?? null;

/** A withdrawn draft was never issued. */
export const wasIssued = (r) => !!r && r.status !== 'DRAFT' && readInstant(r.issuedAt) !== null;

/**
 * The latest revision ever issued: the one the recipient sees and may answer. The current revision is the
 * club's working one, so while N+1 is drafted N stays answerable; issuing N+1 supersedes N, and an answer to
 * N discards the draft.
 */
export function liveRevision(offer) {
  const issued = (offer?.revisions ?? []).filter(wasIssued);
  if (!issued.length) return null;
  return issued.reduce((m, r) => (r.revisionNumber > m.revisionNumber ? r : m));
}
export function liveStatus(offer, now) {
  const l = liveRevision(offer);
  return l ? effectiveRevisionStatus(l, now) : null;
}

export function offerStatus(offer, now) {
  const cur = currentRevision(offer);
  return cur ? effectiveRevisionStatus(cur, now) : null;
}

export function canRevise(offer, now) {
  const st = offerStatus(offer, now);
  if (st === null) return { ok: false, error: 'OFFER_STATE_UNKNOWN' };
  if (st === 'DRAFT')
    return {
      ok: false,
      error: 'OFFER_STATE_INVALID',
      message: 'This Offer already has a draft revision. Edit it or withdraw it.',
    };
  if (st === 'ACCEPTED')
    return {
      ok: false,
      error: 'OFFER_STATE_INVALID',
      message:
        'An accepted Offer is not revised. A contract workflow, or an explicit withdrawal and restart, owns what happens next.',
    };
  if ((offer.revisions ?? []).length >= OFFER_LIMITS.revisions)
    return {
      ok: false,
      error: 'OFFER_STATE_INVALID',
      message: `An Offer carries at most ${OFFER_LIMITS.revisions} revisions.`,
    };
  return { ok: true, from: st };
}

export function canRespondToRevision(offer, revisionId, now) {
  const rev = (offer?.revisions ?? []).find((r) => r && r.id === revisionId) ?? null;
  if (!rev) return { ok: false, error: 'OFFER_NOT_FOUND' };
  if (!wasIssued(rev)) return { ok: false, error: 'OFFER_STATE_INVALID', message: 'This Offer has not been issued.' };
  const st = effectiveRevisionStatus(rev, now);
  if (st === null) return { ok: false, error: 'OFFER_STATE_UNKNOWN' };
  if (st === 'SUPERSEDED' || rev.supersededByRevisionId)
    return {
      ok: false,
      error: 'OFFER_SUPERSEDED',
      message: 'This revision was replaced by a later one. Answer the current revision.',
    };
  if (st === 'WITHDRAWN') return { ok: false, error: 'OFFER_WITHDRAWN', message: 'The club withdrew this Offer.' };
  if (st === 'EXPIRED') return { ok: false, error: 'OFFER_EXPIRED', message: 'This Offer has expired.' };
  if (st === 'ACCEPTED' || st === 'DECLINED' || rev.response)
    return { ok: false, error: 'OFFER_ALREADY_RESPONDED', message: 'This revision already has an answer.' };
  const live = liveRevision(offer);
  if (!live || live.id !== rev.id)
    return { ok: false, error: 'OFFER_SUPERSEDED', message: 'This revision is not the current one.' };
  return { ok: true, revision: rev };
}

export function canWithdrawRevision(offer, now) {
  const rev = currentRevision(offer);
  if (!rev) return { ok: false, error: 'OFFER_STATE_UNKNOWN' };
  const st = effectiveRevisionStatus(rev, now);
  if (st === 'DRAFT' || st === 'ISSUED') return { ok: true, revision: rev, from: st };
  if (st === 'ACCEPTED')
    return {
      ok: false,
      error: 'OFFER_ALREADY_RESPONDED',
      message: 'The recipient has already accepted this Offer; it cannot be withdrawn as if unanswered.',
    };
  if (st === 'DECLINED')
    return { ok: false, error: 'OFFER_ALREADY_RESPONDED', message: 'The recipient has already declined this Offer.' };
  return {
    ok: false,
    error: 'OFFER_STATE_INVALID',
    message: `A revision that is ${OFFER_STATUS_LABELS[st] ?? st} is not withdrawn.`,
    current: { status: st },
  };
}

/** Matches the recipient snapshotted at issue; the route re-checks the live recipient rule. */
export function responderMatches(rev, { kind, actorId, playerId }) {
  const snap = rev?.recipientSnapshot;
  if (!snap || snap.playerId !== playerId) return false;
  if (snap.type !== kind) return false;
  if (kind === 'guardian') return snap.guardianId === actorId;
  return kind === 'player' && actorId === playerId;
}

export const nextRevisionNumber = (offer) =>
  (offer?.revisions ?? []).reduce(
    (m, r) => Math.max(m, Number.isInteger(r?.revisionNumber) ? r.revisionNumber : 0),
    0,
  ) + 1;

// ------------------------------------------------------------------ integrity

/** Structural integrity of a stored Offer, so a route refuses a corrupt row. Never repairs. */
export function offerIntegrity(offer, { orgId = null, caseId = null } = {}) {
  const problems = [];
  if (!offer || typeof offer !== 'object') return ['missing'];
  if (typeof offer.id !== 'string' || !offer.id) problems.push('id');
  if (orgId !== null && offer.orgId !== orgId) problems.push('org_mismatch');
  if (caseId !== null && offer.caseId !== caseId) problems.push('case_mismatch');
  if (typeof offer.playerId !== 'string' || !offer.playerId) problems.push('player');
  if (!OFFER_TYPES.includes(offer.type)) problems.push('type');
  if (!Array.isArray(offer.revisions) || offer.revisions.length === 0) problems.push('revisions');
  else {
    const ids = new Set();
    const nums = new Set();
    for (const r of offer.revisions) {
      if (!r || typeof r.id !== 'string' || ids.has(r.id)) {
        problems.push('revision_id');
        continue;
      }
      ids.add(r.id);
      if (!Number.isInteger(r.revisionNumber) || r.revisionNumber < 1 || nums.has(r.revisionNumber))
        problems.push('revision_number');
      nums.add(r.revisionNumber);
      if (!OFFER_STATUSES.includes(r.status)) problems.push('revision_status');
      // A draft withdrawn before issue has no issue instant or expiry.
      const issuedLike = ['ISSUED', 'ACCEPTED', 'DECLINED', 'SUPERSEDED', 'EXPIRED'].includes(r.status);
      if (issuedLike && readInstant(r.issuedAt) === null) problems.push('issued_at');
      if (issuedLike && readInstant(r.expiresAt) === null) problems.push('expires_at');
      if (r.status === 'WITHDRAWN' && readInstant(r.withdrawnAt) === null) problems.push('withdrawn_at');
      if (
        r.status === 'WITHDRAWN' &&
        r.issuedAt !== null &&
        r.issuedAt !== undefined &&
        readInstant(r.issuedAt) === null
      )
        problems.push('issued_at');
      // Out-of-order or out-of-bounds instants are corruption, and the row is refused rather than read as live.
      const c0 = readInstant(r.createdAt);
      const i0 = readInstant(r.issuedAt);
      const x0 = readInstant(r.expiresAt);
      if (c0 !== null && i0 !== null && i0 < c0) problems.push('issued_before_created');
      if (i0 !== null && readInstant(r.respondedAt) !== null && readInstant(r.respondedAt) < i0)
        problems.push('responded_before_issued');
      if (c0 !== null && readInstant(r.withdrawnAt) !== null && readInstant(r.withdrawnAt) < c0)
        problems.push('withdrawn_before_created');
      if (issuedLike && i0 !== null && x0 !== null && x0 > i0 + OFFER_LIMITS.maxExpiryMs + DAY_MS)
        problems.push('expiry_out_of_bounds');
      if (issuedLike && i0 !== null && x0 !== null && x0 < i0) problems.push('expired_before_issued');
      if (r.status === 'ACCEPTED' || r.status === 'DECLINED') {
        const resp = (offer.responses ?? []).find((x) => x && x.revisionId === r.id);
        if (
          !resp ||
          !OFFER_RESPONSE_TYPES.includes(resp.responseType) ||
          !OFFER_RESPONSE_ACTORS.includes(resp.actorType)
        )
          problems.push('response');
      }
    }
    if (typeof offer.currentRevisionId !== 'string' || !ids.has(offer.currentRevisionId))
      problems.push('current_revision');
    else {
      // The only revision allowed after the current one is a draft discarded when the previous revision was
      // accepted (recorded WITHDRAWN).
      const cur = offer.revisions.find((r) => r && r.id === offer.currentRevisionId);
      if (
        cur &&
        offer.revisions.some(
          (r) =>
            r &&
            r !== cur &&
            Number.isInteger(r.revisionNumber) &&
            r.revisionNumber > cur.revisionNumber &&
            r.status !== 'WITHDRAWN',
        )
      )
        problems.push('current_revision_not_latest');
    }
  }
  if (!Array.isArray(offer.responses)) problems.push('responses');
  else {
    const seen = new Set();
    for (const x of offer.responses) {
      if (!x || typeof x.revisionId !== 'string') {
        problems.push('response_shape');
        continue;
      }
      if (seen.has(x.revisionId)) problems.push('duplicate_response');
      seen.add(x.revisionId);
    }
  }
  return problems;
}

/**
 * The case says where recruitment stands, the Offer what was proposed and answered. Readings that cannot both
 * be true are corruption, refused and not repaired. A case moved away from offer_made while a revision is out
 * is only a warning, and the recipient sees "not answerable right now".
 */
export const OFFER_CASE_CORRUPTION = Object.freeze(['ACCEPTED_BUT_CASE_DECLINED', 'DECLINED_BUT_CASE_ACCEPTED']);
export function offerCaseConsistency(offer, kase, now) {
  const problems = [];
  if (!offer || !kase) return problems;
  const live = liveStatus(offer, now);
  const st = kase.room?.status ?? null;
  if (live === 'ACCEPTED' && st === 'offer_declined') problems.push('ACCEPTED_BUT_CASE_DECLINED');
  if (live === 'DECLINED' && st === 'offer_accepted') problems.push('DECLINED_BUT_CASE_ACCEPTED');
  if (live === 'ISSUED' && st !== 'offer_made') problems.push('LIVE_OFFER_CASE_NOT_AT_OFFER_MADE');
  return problems;
}
export const offerCaseCorrupt = (problems) => (problems ?? []).some((p) => OFFER_CASE_CORRUPTION.includes(p));

// ------------------------------------------------------------------ evidence

/**
 * offer_sent: the live revision is ISSUED and unexpired, or was answered.
 * offer_accepted_by_recipient / offer_declined_by_recipient: the live revision is ACCEPTED / DECLINED with a
 * response row from the snapshotted recipient.
 */
export function offerEvidence(offers, kase, kind, now) {
  if (!Array.isArray(offers)) return { satisfied: false, reason: 'offers_store_unavailable' };
  const own = offers.filter(
    (o) =>
      o &&
      o.caseId === kase.id &&
      o.orgId === kase.orgId &&
      o.playerId === kase.playerId &&
      offerIntegrity(o, { orgId: kase.orgId, caseId: kase.id }).length === 0,
  );
  // A draft beside the live revision is not evidence of anything.
  const withStatus = own
    .map((o) => ({ o, rev: liveRevision(o) }))
    .filter((x) => x.rev)
    .map((x) => ({ ...x, st: effectiveRevisionStatus(x.rev, now) }));
  if (kind === 'offer_sent') {
    const hit = withStatus.find((x) => x.st === 'ISSUED' || x.st === 'ACCEPTED' || x.st === 'DECLINED');
    return hit
      ? { satisfied: true, sourceType: 'recruitment_offer', sourceId: hit.o.id, revisionId: hit.rev.id }
      : { satisfied: false, reason: 'no_issued_offer' };
  }
  if (kind === 'offer_accepted_by_recipient' || kind === 'offer_declined_by_recipient') {
    const want = kind === 'offer_accepted_by_recipient' ? 'ACCEPTED' : 'DECLINED';
    const hit = withStatus.find(
      (x) =>
        x.st === want &&
        (x.o.responses ?? []).some(
          (r) =>
            r &&
            r.revisionId === x.rev.id &&
            r.responseType === want.toLowerCase() &&
            responderMatches(x.rev, { kind: r.actorType, actorId: r.actorId, playerId: x.o.playerId }),
        ),
    );
    return hit
      ? { satisfied: true, sourceType: 'recruitment_offer', sourceId: hit.o.id, revisionId: hit.rev.id }
      : { satisfied: false, reason: want === 'ACCEPTED' ? 'no_recipient_acceptance' : 'no_recipient_decline' };
  }
  return { satisfied: false, reason: 'unknown_evidence_kind' };
}

// ------------------------------------------------------------------ views

const actorView = (a) => (a ? { kind: a.kind ?? null, name: a.name ?? null } : null);

function revisionBase(r, now) {
  return {
    id: r.id,
    revisionNumber: r.revisionNumber,
    status: effectiveRevisionStatus(r, now),
    storedStatus: r.status,
    statusLabel: OFFER_STATUS_LABELS[effectiveRevisionStatus(r, now)] ?? null,
    terms: { ...r.terms },
    recipientMessage: r.recipientMessage ?? null,
    documents: (r.documents ?? []).map((d) => ({ id: d.id, label: d.label ?? null })),
    expiresAt: r.expiresAt ?? null,
    issuedAt: r.issuedAt ?? null,
    createdAt: r.createdAt ?? null,
    supersedesRevisionId: r.supersedesRevisionId ?? null,
    supersededByRevisionId: r.supersededByRevisionId ?? null,
    withdrawnAt: r.withdrawnAt ?? null,
    respondedAt: r.respondedAt ?? null,
    rev: Number.isInteger(r.rev) ? r.rev : 1,
  };
}

/** The club's view, including the internal note and provenance references. */
export function offerClubView(offer, now) {
  const cur = currentRevision(offer);
  return {
    id: offer.id,
    caseId: offer.caseId,
    playerId: offer.playerId,
    orgId: offer.orgId,
    type: offer.type,
    status: offerStatus(offer, now),
    statusLabel: OFFER_STATUS_LABELS[offerStatus(offer, now)] ?? null,
    currentRevisionId: offer.currentRevisionId,
    liveRevisionId: liveRevision(offer)?.id ?? null,
    liveStatus: liveStatus(offer, now),
    awaitingResponse: liveStatus(offer, now) === 'ISSUED',
    currentRevision: cur
      ? {
          ...revisionBase(cur, now),
          internalNote: cur.internalNote ?? null,
          issuedBy: actorView(cur.issuedBy),
          createdBy: actorView(cur.createdBy),
          withdrawnBy: actorView(cur.withdrawnBy),
          withdrawReason: cur.withdrawReason ?? null,
          recipient: cur.recipientSnapshot
            ? { type: cur.recipientSnapshot.type, minor: cur.recipientSnapshot.minor === true }
            : null,
          readiness: cur.readinessSnapshot ?? null,
        }
      : null,
    revisions: (offer.revisions ?? [])
      .slice()
      .sort((a, b) => a.revisionNumber - b.revisionNumber)
      .map((r) => ({
        ...revisionBase(r, now),
        internalNote: r.internalNote ?? null,
        issuedBy: actorView(r.issuedBy),
        createdBy: actorView(r.createdBy),
        withdrawnBy: actorView(r.withdrawnBy),
        withdrawReason: r.withdrawReason ?? null,
      })),
    responses: (offer.responses ?? []).map((x) => ({
      id: x.id,
      revisionId: x.revisionId,
      responseType: x.responseType,
      actorType: x.actorType,
      forPlayerId: x.forPlayerId,
      occurredAt: x.occurredAt,
      reason: x.reason ?? null,
    })),
    firstViewedAt: (offer.readReceipts ?? []).reduce(
      (m, r) => (r && Number.isFinite(r.firstViewedAt) && (m === null || r.firstViewedAt < m) ? r.firstViewedAt : m),
      null,
    ),
    agentShared: !!offer.agentShare,
    decisionId: offer.decisionId ?? null,
    transactionId: offer.transactionId ?? null,
    lifecycle: offer.lifecycle ?? null,
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt ?? null,
    rev: Number.isInteger(offer.rev) ? offer.rev : 1,
    policyVersion: OFFER_POLICY_VERSION,
    honest:
      "An Offer is the club's proposal, issued as an exact revision. An acceptance in ScoutBox is the recipient saying yes to that revision; it is not a signing, not a registration and not an executed contract.",
  };
}

/** The recipient's view: never the internal note, a draft, the decision or transaction reference, or readiness. */
export function offerRecipientView(offer, now, { orgName = null, caseOpen = true } = {}) {
  const issued = (offer.revisions ?? []).filter(wasIssued).sort((a, b) => a.revisionNumber - b.revisionNumber);
  const curIssued = liveRevision(offer);
  const st = curIssued ? effectiveRevisionStatus(curIssued, now) : null;
  return {
    id: offer.id,
    playerId: offer.playerId,
    club: { id: offer.orgId, name: orgName },
    type: offer.type,
    status: st,
    statusLabel: OFFER_STATUS_LABELS[st] ?? null,
    currentRevisionId: curIssued ? curIssued.id : null,
    currentRevision: curIssued ? revisionBase(curIssued, now) : null,
    revisions: issued.map((r) => revisionBase(r, now)),
    awaitingYourResponse: st === 'ISSUED' && caseOpen,
    // A paused or moved case cannot be answered; the recipient is told so instead of hitting a 409.
    answerable: st === 'ISSUED' && caseOpen,
    notAnswerableReason: st === 'ISSUED' && !caseOpen ? 'CASE_PAUSED' : null,
    responses: (offer.responses ?? []).map((x) => ({
      id: x.id,
      revisionId: x.revisionId,
      responseType: x.responseType,
      actorType: x.actorType,
      occurredAt: x.occurredAt,
    })),
    agentShared: !!offer.agentShare,
    policyVersion: OFFER_POLICY_VERSION,
    honest:
      'Accepting an Offer in ScoutBox tells the club you say yes to exactly these terms. It is not a signature, not a registration and not a contract; nothing is signed here.',
  };
}

/** The agent's view of an Offer the client shared: never the internal note or documents. */
export function offerAgentView(offer, now, { orgName = null } = {}) {
  const view = offerRecipientView(offer, now, { orgName });
  return {
    id: view.id,
    clientId: view.playerId,
    club: view.club,
    type: view.type,
    status: view.status,
    statusLabel: view.statusLabel,
    currentRevision: view.currentRevision ? { ...view.currentRevision, documents: [] } : null,
    revisions: view.revisions.map((r) => ({ ...r, documents: [] })),
    awaitingClientResponse: view.awaitingYourResponse,
    responses: view.responses,
    sharedAt: offer.agentShare?.at ?? null,
    honest:
      "Your client shared this Offer with you. Accepting or declining is your client's own act; ScoutBox does not let you answer on their behalf, and nothing here is a negotiation, a fee or a signing.",
  };
}

// ------------------------------------------------------------------ history

/** The numeric id suffix breaks ties within a millisecond. */
const SEQ = (id) => {
  const n = Number(
    String(id ?? '')
      .split('-')
      .pop(),
  );
  return Number.isFinite(n) ? n : 0;
};
export const byAtThenId = (a, b) => a.at - b.at || SEQ(a.id) - SEQ(b.id);

/** Ids, states, times, actor kind and name only. */
export function offerHistoryView(offer, { forRecipient = false } = {}) {
  return (offer.history ?? [])
    .slice()
    .sort(byAtThenId)
    .filter((h) => !forRecipient || !/draft|internal/.test(h.action))
    .map((h) => ({
      id: h.id,
      at: h.at,
      action: h.action,
      by: actorView(h.by),
      revisionId: h.detail?.revisionId ?? null,
    }));
}
