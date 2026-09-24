/**
 * M23 P6 — the canonical Offer domain: pure functions over one
 * `db.recruitmentOffers` row and a clock. Nothing here reads `db`, answers
 * HTTP or writes a case status.
 *
 * THE CHAIN THIS MODULE KEEPS DISTINCT (mandate §0)
 *
 *   recruitment decision ≠ offer ≠ offer acceptance ≠ signing
 *
 *   - a positive P5 decision moves the case to `offer_consideration` and
 *     creates NOTHING here (§A, §10);
 *   - an Offer exists only through an explicit, authorised club action (§B);
 *   - only an ISSUED revision can move the lifecycle to `offer_made` (§C);
 *   - an issued revision is immutable; changed terms are a NEW revision (§E,
 *     §F); acceptance and decline name one exact issued revision (§G, §H);
 *   - superseded, withdrawn and expired revisions cannot be accepted (§I–§K);
 *   - an accepted Offer is NOT a signing: no `db.signings` row, no `signed`
 *     state, no `under_contract` (§L, §M, §83).
 *
 * THE RECORD
 *
 *   offer            the logical container: org, case, player, decision
 *                    provenance, an optional transaction reference, the
 *                    revision chain, the append-only response history, the
 *                    read receipts, the idempotency keys, the audit history
 *   offer.revisions  exact revisions. DRAFT is editable under rev control;
 *                    ISSUE freezes it; every later state is terminal FOR THAT
 *                    REVISION. The container's `status` mirrors the current
 *                    revision's stored status for the journey projection.
 *   offer.responses  one authoritative recipient response per revision,
 *                    append-only, with actor provenance (a guardian is never
 *                    written as the player).
 *
 * EXPIRY (§20–§21) is a UTC_INSTANT on the revision, parsed by the P5.7
 * canonical parser. `effectiveRevisionStatus` reads an ISSUED revision whose
 * expiry has passed — or cannot be read — as EXPIRED without any job having
 * run: the security decision never depends on a materialised status.
 */

import { parseInstant, parseStrictDateOnly, isExpiredAt, readInstant, isAbsent, DAY_MS } from '../temporal.mjs';

export const OFFER_POLICY_VERSION = 1;

const table = (o) => Object.freeze(Object.assign(Object.create(null), o));
const has = (t, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(t, k);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------ vocabulary

/** The seven revision statuses (§5). Nothing else exists; `viewed` is a receipt, not a status (§40). */
export const OFFER_STATUSES = Object.freeze(['DRAFT', 'ISSUED', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED', 'SUPERSEDED']);
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

/**
 * Revision transitions (§5). Terminal at revision level. There is no edge out
 * of ACCEPTED: a later contract workflow or an explicit restart owns that.
 */
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
 * The one Offer context P6 supports (§8). A transfer or a loan needs a
 * releasing club, which is the P5.6D transaction's business; the engaging
 * club's Offer to the player stays distinct from club-to-club terms, and a
 * context this build cannot model honestly is refused rather than approximated.
 */
export const OFFER_TYPES = Object.freeze(['direct_recruitment']);

/** Recipient response kinds (§54). One authoritative response per active revision. */
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
  clientKey: 64,
  /** An issued Offer must expire at least one hour after issue and within 180 days. */
  minExpiryMs: 60 * 60 * 1000,
  maxExpiryMs: 180 * DAY_MS,
  historyPage: 200,
});

/**
 * Minor recipients (§13). No jurisdiction-specific legal policy for an Offer
 * to a minor is encoded in this build, so the pathway is CLOSED everywhere:
 * an Offer whose recipient resolves to a guardian route is refused at ISSUE
 * with `OFFER_RECIPIENT_INVALID`. The guardian routes exist and are
 * fail-closed; they act only where a future policy opens this table. Read
 * from a table rather than hard-coded so enabling one is a policy change.
 */
export const MINOR_OFFER_PATHWAY_ENABLED = Object.freeze({ GB: false, ENG: false, INT: false, USA: false, DEFAULT: false });
export const minorOfferPathwayOpen = (jurisdiction, policy = MINOR_OFFER_PATHWAY_ENABLED) =>
  (jurisdiction && has(policy, jurisdiction) ? policy[jurisdiction] === true : policy.DEFAULT === true);

// ------------------------------------------------------------------ keys

export function normaliseOfferClientKey(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, key: null };
  if (typeof raw !== 'string') return { ok: false, error: 'OFFER_CLIENT_KEY_INVALID', message: 'clientKey must be text.' };
  const k = raw.trim();
  if (!k || k.length > OFFER_LIMITS.clientKey) return { ok: false, error: 'OFFER_CLIENT_KEY_INVALID', message: 'clientKey must be 1–64 characters.' };
  return { ok: true, key: k };
}

/** A stable fingerprint of the parts of a request that make it "the same request". */
export const payloadFingerprint = (parts) => JSON.stringify(parts, Object.keys(parts).sort());

// ------------------------------------------------------------------ terms

function cleanText(raw, max, { oneLine = false } = {}) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  // eslint-disable-next-line no-control-regex
  let s = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (oneLine) s = s.replace(/[\r\n]+/g, ' ');
  s = s.trim();
  if (s.length > max) return { ok: false, tooLong: true };
  return { ok: true, value: s || null };
}

/**
 * The structured terms (§7): deliberately narrow. A role, a squad, a start
 * day, an optional end day, and conditions in the club's own words. No
 * compensation field exists in this product and none is invented; nothing
 * here is a legal clause and nothing here is an executed contract.
 *
 * Every field is optional on a DRAFT; `startDate` is required at ISSUE
 * (`requireComplete`). Days are DATE_ONLY (a contract starts on a day, not at
 * an instant); the pair must be ordered.
 */
export function validateTerms(raw, { requireComplete = false } = {}) {
  const bad = (field, message, extra = {}) => ({ ok: false, error: 'OFFER_TERMS_INVALID', field, message, ...extra });
  if (raw !== undefined && raw !== null && !isPlain(raw)) return bad('terms', 'terms must be an object.');
  const t = raw ?? {};
  const offerType = t.offerType === undefined || t.offerType === null ? 'direct_recruitment' : t.offerType;
  if (!OFFER_TYPES.includes(offerType)) return bad('offerType', `offerType must be one of ${OFFER_TYPES.join(', ')}.`, { allowed: OFFER_TYPES });
  const role = cleanText(t.role, OFFER_LIMITS.role, { oneLine: true });
  if (!role.ok) return bad('role', role.tooLong ? `Keep the role under ${OFFER_LIMITS.role} characters.` : 'The role must be text.');
  const squad = cleanText(t.squad, OFFER_LIMITS.squad, { oneLine: true });
  if (!squad.ok) return bad('squad', squad.tooLong ? `Keep the squad under ${OFFER_LIMITS.squad} characters.` : 'The squad must be text.');
  const conditions = cleanText(t.conditions, OFFER_LIMITS.conditions);
  if (!conditions.ok) return bad('conditions', conditions.tooLong ? `Keep the conditions under ${OFFER_LIMITS.conditions} characters.` : 'Conditions must be text.');
  let startDate = null;
  if (!isAbsent(t.startDate)) {
    const p = parseStrictDateOnly(t.startDate);
    if (!p.ok) return bad('startDate', `The start date must be a calendar day written YYYY-MM-DD (${p.why}).`, { expected: 'YYYY-MM-DD' });
    startDate = p.value;
  }
  let endDate = null;
  if (!isAbsent(t.endDate)) {
    const p = parseStrictDateOnly(t.endDate);
    if (!p.ok) return bad('endDate', `The end date must be a calendar day written YYYY-MM-DD (${p.why}).`, { expected: 'YYYY-MM-DD' });
    endDate = p.value;
  }
  if (startDate && endDate && !(startDate < endDate)) return bad('endDate', 'The end date must be after the start date.');
  if (requireComplete && !startDate) return bad('startDate', 'An issued Offer names the day it would start.');
  return { ok: true, terms: { offerType, role: role.value, squad: squad.value, startDate, endDate, conditions: conditions.value } };
}

/** The recipient-visible message and the club-private note: two fields, never one (§34). */
export function validateMessages({ recipientMessage, internalNote } = {}) {
  const bad = (field, message) => ({ ok: false, error: 'OFFER_INPUT_INVALID', field, message });
  const m = cleanText(recipientMessage, OFFER_LIMITS.recipientMessage);
  if (!m.ok) return bad('recipientMessage', m.tooLong ? `Keep the message under ${OFFER_LIMITS.recipientMessage} characters.` : 'The message must be text.');
  const n = cleanText(internalNote, OFFER_LIMITS.internalNote);
  if (!n.ok) return bad('internalNote', n.tooLong ? `Keep the internal note under ${OFFER_LIMITS.internalNote} characters.` : 'The internal note must be text.');
  return { ok: true, recipientMessage: m.value, internalNote: n.value };
}

/**
 * The expiry (§20, §48, §49): a UTC_INSTANT with an explicit offset or Z, or
 * integer milliseconds — never a bare local time, never the client's clock.
 * At ISSUE it must lie at least an hour ahead of the server's now and within
 * 180 days. A DRAFT may carry none.
 */
export function validateExpiry(raw, { now, required = false } = {}) {
  const bad = (message, extra = {}) => ({ ok: false, error: 'OFFER_EXPIRY_INVALID', field: 'expiresAt', message, ...extra });
  if (isAbsent(raw)) return required ? bad('An issued Offer needs an expiry.') : { ok: true, ms: null };
  const p = parseInstant(raw);
  if (!p.ok) return bad(`expiresAt must be an ISO 8601 date-time with an explicit offset or Z, or a millisecond timestamp (${p.why}).`, { expected: p.expected });
  if (Number.isFinite(now)) {
    if (p.ms < now + OFFER_LIMITS.minExpiryMs) return bad('An Offer must stay open for at least an hour after it is issued.');
    if (p.ms > now + OFFER_LIMITS.maxExpiryMs) return bad('An Offer cannot stay open for more than 180 days.');
  }
  return { ok: true, ms: p.ms };
}

/** Document references (§31): the canonical evidence vault by id, with a label; no bytes, no paths. */
export function validateDocumentRefs(raw) {
  const bad = (message, extra = {}) => ({ ok: false, error: 'OFFER_DOCUMENT_INVALID', field: 'documents', message, ...extra });
  if (raw === undefined) return { ok: true, documents: undefined };
  if (!Array.isArray(raw)) return bad('documents must be a list.');
  if (raw.length > OFFER_LIMITS.documents) return bad(`An Offer carries at most ${OFFER_LIMITS.documents} documents.`);
  const out = [];
  const seen = new Set();
  for (const d of raw) {
    if (!isPlain(d) || typeof d.evidenceId !== 'string' || !d.evidenceId.trim()) return bad('Each document names an evidence record by id.');
    const id = d.evidenceId.trim();
    if (seen.has(id)) return bad('A document appears twice.');
    seen.add(id);
    const label = cleanText(d.label, OFFER_LIMITS.documentLabel, { oneLine: true });
    if (!label.ok) return bad(label.tooLong ? `Keep a document label under ${OFFER_LIMITS.documentLabel} characters.` : 'A document label must be text.');
    out.push({ evidenceId: id, label: label.value });
  }
  return { ok: true, documents: out };
}

// ------------------------------------------------------------------ status

/**
 * The status a revision HAS at `now`. Stored ISSUED with a passed — or
 * unreadable — expiry reads EXPIRED (§21). Every other stored status reads as
 * stored. A stored status this build does not know reads as corruption.
 */
export function effectiveRevisionStatus(rev, now) {
  if (!rev || !OFFER_STATUSES.includes(rev.status)) return null;
  if (rev.status === 'ISSUED' && isExpiredAt(rev.expiresAt ?? NaN, now)) return 'EXPIRED';
  return rev.status;
}

export const currentRevision = (offer) => (offer?.revisions ?? []).find((r) => r && r.id === offer.currentRevisionId) ?? null;

/** A revision the recipient was ever shown: it left DRAFT by being ISSUED (a withdrawn draft never was). */
export const wasIssued = (r) => !!r && r.status !== 'DRAFT' && readInstant(r.issuedAt) !== null;

/**
 * The LIVE revision — the one the recipient sees and may answer: the latest
 * revision that was ever issued. Distinct from the CURRENT revision, which is
 * the club's working one (a new draft while revision N is out). While the
 * club drafts revision N+1, revision N stays answerable; issuing N+1
 * supersedes N; an answer to N discards the unissued draft (§25, §26).
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

/** The Offer's status is its current revision's effective status. */
export function offerStatus(offer, now) {
  const cur = currentRevision(offer);
  return cur ? effectiveRevisionStatus(cur, now) : null;
}

/** May a new revision be drafted on this Offer (§25)? Not over an accepted one, not over a live draft. */
export function canRevise(offer, now) {
  const st = offerStatus(offer, now);
  if (st === null) return { ok: false, error: 'OFFER_STATE_UNKNOWN' };
  if (st === 'DRAFT') return { ok: false, error: 'OFFER_STATE_INVALID', message: 'This Offer already has a draft revision. Edit it or withdraw it.' };
  if (st === 'ACCEPTED') return { ok: false, error: 'OFFER_STATE_INVALID', message: 'An accepted Offer is not revised. A contract workflow, or an explicit withdrawal and restart, owns what happens next.' };
  if ((offer.revisions ?? []).length >= OFFER_LIMITS.revisions) return { ok: false, error: 'OFFER_STATE_INVALID', message: `An Offer carries at most ${OFFER_LIMITS.revisions} revisions.` };
  return { ok: true, from: st };
}

/**
 * THE acceptance/decline gate (§22, §23), for one exact revision at `now`.
 * Returns the refusal that names why, or ok. Order: the revision must exist on
 * this Offer, be the current one, be ISSUED (not expired), and carry no
 * response yet.
 */
export function canRespondToRevision(offer, revisionId, now) {
  const rev = (offer?.revisions ?? []).find((r) => r && r.id === revisionId) ?? null;
  if (!rev) return { ok: false, error: 'OFFER_NOT_FOUND' };
  if (!wasIssued(rev)) return { ok: false, error: 'OFFER_STATE_INVALID', message: 'This Offer has not been issued.' };
  const st = effectiveRevisionStatus(rev, now);
  if (st === null) return { ok: false, error: 'OFFER_STATE_UNKNOWN' };
  if (st === 'SUPERSEDED' || rev.supersededByRevisionId) return { ok: false, error: 'OFFER_SUPERSEDED', message: 'This revision was replaced by a later one. Answer the current revision.' };
  if (st === 'WITHDRAWN') return { ok: false, error: 'OFFER_WITHDRAWN', message: 'The club withdrew this Offer.' };
  if (st === 'EXPIRED') return { ok: false, error: 'OFFER_EXPIRED', message: 'This Offer has expired.' };
  if (st === 'ACCEPTED' || st === 'DECLINED' || rev.response) return { ok: false, error: 'OFFER_ALREADY_RESPONDED', message: 'This revision already has an answer.' };
  const live = liveRevision(offer);
  if (!live || live.id !== rev.id) return { ok: false, error: 'OFFER_SUPERSEDED', message: 'This revision is not the current one.' };
  return { ok: true, revision: rev };
}

/** May the club withdraw this revision (§24)? A DRAFT or an ISSUED, unanswered, unexpired revision. */
export function canWithdrawRevision(offer, now) {
  const rev = currentRevision(offer);
  if (!rev) return { ok: false, error: 'OFFER_STATE_UNKNOWN' };
  const st = effectiveRevisionStatus(rev, now);
  if (st === 'DRAFT' || st === 'ISSUED') return { ok: true, revision: rev, from: st };
  if (st === 'ACCEPTED') return { ok: false, error: 'OFFER_ALREADY_RESPONDED', message: 'The recipient has already accepted this Offer; it cannot be withdrawn as if unanswered.' };
  if (st === 'DECLINED') return { ok: false, error: 'OFFER_ALREADY_RESPONDED', message: 'The recipient has already declined this Offer.' };
  return { ok: false, error: 'OFFER_STATE_INVALID', message: `A revision that is ${OFFER_STATUS_LABELS[st] ?? st} is not withdrawn.`, current: { status: st } };
}

/** Which recipient may answer an issued revision: the one snapshotted at ISSUE, re-checked by the route against the live recipient rule. */
export function responderMatches(rev, { kind, actorId, playerId }) {
  const snap = rev?.recipientSnapshot;
  if (!snap || snap.playerId !== playerId) return false;
  if (snap.type !== kind) return false;
  if (kind === 'guardian') return snap.guardianId === actorId;
  return kind === 'player' && actorId === playerId;
}

/** The next revision number: monotonic, never reused. */
export const nextRevisionNumber = (offer) => (offer?.revisions ?? []).reduce((m, r) => Math.max(m, Number.isInteger(r?.revisionNumber) ? r.revisionNumber : 0), 0) + 1;

// ------------------------------------------------------------------ integrity

/**
 * Structural integrity of a stored Offer, for a route to refuse to serve or
 * mutate a corrupt row rather than reason over it. Never repairs.
 */
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
    const ids = new Set(); const nums = new Set();
    for (const r of offer.revisions) {
      if (!r || typeof r.id !== 'string' || ids.has(r.id)) { problems.push('revision_id'); continue; }
      ids.add(r.id);
      if (!Number.isInteger(r.revisionNumber) || nums.has(r.revisionNumber)) problems.push('revision_number');
      nums.add(r.revisionNumber);
      if (!OFFER_STATUSES.includes(r.status)) problems.push('revision_status');
      // A revision that left DRAFT by being issued carries the instant it was
      // issued and a readable expiry; a draft withdrawn before issue carries
      // neither, and the instant it was withdrawn instead.
      const issuedLike = ['ISSUED', 'ACCEPTED', 'DECLINED', 'SUPERSEDED', 'EXPIRED'].includes(r.status);
      if (issuedLike && readInstant(r.issuedAt) === null) problems.push('issued_at');
      if (issuedLike && readInstant(r.expiresAt) === null) problems.push('expires_at');
      if (r.status === 'WITHDRAWN' && readInstant(r.withdrawnAt) === null) problems.push('withdrawn_at');
      if (r.status === 'WITHDRAWN' && r.issuedAt !== null && r.issuedAt !== undefined && readInstant(r.issuedAt) === null) problems.push('issued_at');
      if (r.status === 'ACCEPTED' || r.status === 'DECLINED') {
        const resp = (offer.responses ?? []).find((x) => x && x.revisionId === r.id);
        if (!resp || !OFFER_RESPONSE_TYPES.includes(resp.responseType) || !OFFER_RESPONSE_ACTORS.includes(resp.actorType)) problems.push('response');
      }
    }
    if (!ids.has(offer.currentRevisionId)) problems.push('current_revision');
  }
  if (!Array.isArray(offer.responses)) problems.push('responses');
  else {
    const seen = new Set();
    for (const x of offer.responses) {
      if (!x || typeof x.revisionId !== 'string') { problems.push('response_shape'); continue; }
      if (seen.has(x.revisionId)) problems.push('duplicate_response');
      seen.add(x.revisionId);
    }
  }
  return problems;
}

// ------------------------------------------------------------------ evidence

/**
 * The lifecycle evidence (M23 §14) for the three offer kinds, read from the
 * canonical rows and written nowhere. Same direction as every other kind:
 * offer truth → lifecycle; lifecycle never → offer truth.
 *
 *   offer_sent                    an Offer of THIS case whose CURRENT revision
 *                                 is ISSUED and unexpired at `now`, or has
 *                                 been answered (an accepted or declined
 *                                 revision was sent too)
 *   offer_accepted_by_recipient   the current revision is ACCEPTED, with a
 *                                 recipient response row that names the
 *                                 snapshotted recipient
 *   offer_declined_by_recipient   likewise, DECLINED
 */
export function offerEvidence(offers, kase, kind, now) {
  if (!Array.isArray(offers)) return { satisfied: false, reason: 'offers_store_unavailable' };
  const own = offers.filter((o) => o && o.caseId === kase.id && o.orgId === kase.orgId && o.playerId === kase.playerId && offerIntegrity(o, { orgId: kase.orgId, caseId: kase.id }).length === 0);
  // The LIVE revision is what the recipient was sent; a draft the club is
  // working on beside it is not evidence of anything.
  const withStatus = own.map((o) => ({ o, rev: liveRevision(o) })).filter((x) => x.rev).map((x) => ({ ...x, st: effectiveRevisionStatus(x.rev, now) }));
  if (kind === 'offer_sent') {
    const hit = withStatus.find((x) => x.st === 'ISSUED' || x.st === 'ACCEPTED' || x.st === 'DECLINED');
    return hit ? { satisfied: true, sourceType: 'recruitment_offer', sourceId: hit.o.id, revisionId: hit.rev.id } : { satisfied: false, reason: 'no_issued_offer' };
  }
  if (kind === 'offer_accepted_by_recipient' || kind === 'offer_declined_by_recipient') {
    const want = kind === 'offer_accepted_by_recipient' ? 'ACCEPTED' : 'DECLINED';
    const hit = withStatus.find((x) => x.st === want && (x.o.responses ?? []).some((r) => r && r.revisionId === x.rev.id && r.responseType === want.toLowerCase() && responderMatches(x.rev, { kind: r.actorType, actorId: r.actorId, playerId: x.o.playerId })));
    return hit ? { satisfied: true, sourceType: 'recruitment_offer', sourceId: hit.o.id, revisionId: hit.rev.id } : { satisfied: false, reason: want === 'ACCEPTED' ? 'no_recipient_acceptance' : 'no_recipient_decline' };
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

/** The club's view: everything, including the internal note and the provenance references. */
export function offerClubView(offer, now) {
  const cur = currentRevision(offer);
  return {
    id: offer.id, caseId: offer.caseId, playerId: offer.playerId, orgId: offer.orgId, type: offer.type,
    status: offerStatus(offer, now), statusLabel: OFFER_STATUS_LABELS[offerStatus(offer, now)] ?? null,
    currentRevisionId: offer.currentRevisionId,
    liveRevisionId: liveRevision(offer)?.id ?? null,
    liveStatus: liveStatus(offer, now),
    awaitingResponse: liveStatus(offer, now) === 'ISSUED',
    currentRevision: cur ? { ...revisionBase(cur, now), internalNote: cur.internalNote ?? null, issuedBy: actorView(cur.issuedBy), createdBy: actorView(cur.createdBy), withdrawnBy: actorView(cur.withdrawnBy), withdrawReason: cur.withdrawReason ?? null, recipient: cur.recipientSnapshot ? { type: cur.recipientSnapshot.type, minor: cur.recipientSnapshot.minor === true } : null, readiness: cur.readinessSnapshot ?? null } : null,
    revisions: (offer.revisions ?? []).slice().sort((a, b) => a.revisionNumber - b.revisionNumber).map((r) => ({ ...revisionBase(r, now), internalNote: r.internalNote ?? null, issuedBy: actorView(r.issuedBy), createdBy: actorView(r.createdBy), withdrawnBy: actorView(r.withdrawnBy), withdrawReason: r.withdrawReason ?? null })),
    responses: (offer.responses ?? []).map((x) => ({ id: x.id, revisionId: x.revisionId, responseType: x.responseType, actorType: x.actorType, forPlayerId: x.forPlayerId, occurredAt: x.occurredAt, reason: x.reason ?? null })),
    firstViewedAt: (offer.readReceipts ?? []).reduce((m, r) => (r && Number.isFinite(r.firstViewedAt) && (m === null || r.firstViewedAt < m) ? r.firstViewedAt : m), null),
    agentShared: !!offer.agentShare,
    decisionId: offer.decisionId ?? null,
    transactionId: offer.transactionId ?? null,
    lifecycle: offer.lifecycle ?? null,
    createdAt: offer.createdAt, updatedAt: offer.updatedAt ?? null,
    rev: Number.isInteger(offer.rev) ? offer.rev : 1,
    policyVersion: OFFER_POLICY_VERSION,
    honest: 'An Offer is the club\'s proposal, issued as an exact revision. An acceptance in ScoutBox is the recipient saying yes to that revision; it is not a signing, not a registration and not an executed contract.',
  };
}

/**
 * The recipient's view (player or guardian): the ISSUED revisions and their
 * outcomes, the recipient message, the documents, the expiry. Never the
 * internal note, never a draft, never the decision or transaction reference,
 * never the readiness blockers.
 */
export function offerRecipientView(offer, now, { orgName = null } = {}) {
  const issued = (offer.revisions ?? []).filter(wasIssued).sort((a, b) => a.revisionNumber - b.revisionNumber);
  const curIssued = liveRevision(offer);
  const st = curIssued ? effectiveRevisionStatus(curIssued, now) : null;
  return {
    id: offer.id, playerId: offer.playerId, club: { id: offer.orgId, name: orgName },
    type: offer.type,
    status: st, statusLabel: OFFER_STATUS_LABELS[st] ?? null,
    currentRevisionId: curIssued ? curIssued.id : null,
    currentRevision: curIssued ? revisionBase(curIssued, now) : null,
    revisions: issued.map((r) => revisionBase(r, now)),
    awaitingYourResponse: st === 'ISSUED',
    responses: (offer.responses ?? []).map((x) => ({ id: x.id, revisionId: x.revisionId, responseType: x.responseType, actorType: x.actorType, occurredAt: x.occurredAt })),
    agentShared: !!offer.agentShare,
    policyVersion: OFFER_POLICY_VERSION,
    honest: 'Accepting an Offer in ScoutBox tells the club you say yes to exactly these terms. It is not a signature, not a registration and not a contract; nothing is signed here.',
  };
}

/** The agent's view (§12, §42): read-only terms and state of a client's Offer the client shared; never the internal note, never documents. */
export function offerAgentView(offer, now, { orgName = null } = {}) {
  const v = offerRecipientView(offer, now, { orgName });
  return {
    id: v.id, clientId: v.playerId, club: v.club, type: v.type, status: v.status, statusLabel: v.statusLabel,
    currentRevision: v.currentRevision ? { ...v.currentRevision, documents: [] } : null,
    revisions: v.revisions.map((r) => ({ ...r, documents: [] })),
    awaitingClientResponse: v.awaitingYourResponse,
    responses: v.responses,
    sharedAt: offer.agentShare?.at ?? null,
    honest: 'Your client shared this Offer with you. Accepting or declining is your client\'s own act; ScoutBox does not let you answer on their behalf, and nothing here is a negotiation, a fee or a signing.',
  };
}

// ------------------------------------------------------------------ history

/** Time, then the monotonic id part — two entries in one millisecond never swap. */
const SEQ = (id) => { const n = Number(String(id ?? '').split('-').pop()); return Number.isFinite(n) ? n : 0; };
export const byAtThenId = (a, b) => (a.at - b.at) || (SEQ(a.id) - SEQ(b.id));

/** Entries a person can read: ids, states, times, actor kind and name only. */
export function offerHistoryView(offer, { forRecipient = false } = {}) {
  return (offer.history ?? []).slice().sort(byAtThenId)
    .filter((h) => !forRecipient || !/draft|internal/.test(h.action))
    .map((h) => ({ id: h.id, at: h.at, action: h.action, by: actorView(h.by), revisionId: h.detail?.revisionId ?? null }));
}
