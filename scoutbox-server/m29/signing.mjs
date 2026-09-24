/**
 * M23 P7 — the signing domain, pure.
 *
 *   Recruitment Decision ≠ Offer ≠ Offer Acceptance ≠ Signing ≠ Contract effective
 *
 * A signing PACKAGE is the workflow record (`db.signingPackages`): opened by an
 * explicit club act over an ACCEPTED Offer revision, carrying immutable signing
 * REVISIONS (the exact document, its digest, the required parties, the contract
 * dates), the parties' completion evidence, keys, history and a rev. A
 * completed signing (`db.signings`) is a different thing: the authoritative
 * record that the canonical completion writes exactly once, and that the
 * lifecycle's `signed` state rests on. Nothing here writes; every function
 * takes a record and answers.
 *
 * Frozen principles (§3 A–Q): an accepted Offer creates no package; a package
 * is opened by an authorised human; completion needs every required party's
 * evidence against the exact current revision; a partial, cancelled, voided,
 * expired or superseded package is not a signing; no historical signature is
 * inferred; an agent never signs as anyone; ScoutBox executes no agreement and
 * claims no legal effect beyond the workflow and evidence it records (§103).
 */

import { parseStrictDateOnly, parseInstant, readInstant, isExpiredAt, isOrderedInterval, DAY_MS } from '../temporal.mjs';

export const SIGNING_POLICY_VERSION = 1;

export const SIGNING_STATUSES = Object.freeze(['DRAFT', 'READY', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'VOIDED', 'EXPIRED', 'SUPERSEDED']);
export const SIGNING_TERMINAL = Object.freeze(['COMPLETED', 'CANCELLED', 'VOIDED', 'EXPIRED']);
/** Statuses a package can be STORED in. EXPIRED is derived at read time and never written (§36); SUPERSEDED is a revision's status, never the package's. */
export const SIGNING_STORED_STATUSES = Object.freeze(['DRAFT', 'READY', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'VOIDED']);
export const SIGNING_REVISION_STATUSES = Object.freeze(['DRAFT', 'READY', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'VOIDED', 'SUPERSEDED']);
export const SIGNING_STATUS_LABELS = Object.freeze({
  DRAFT: 'Draft — not presented for signing',
  READY: 'Presented — awaiting signatures',
  IN_PROGRESS: 'In progress — some signatures recorded',
  COMPLETED: 'Signing completed',
  CANCELLED: 'Cancelled',
  VOIDED: 'Voided',
  EXPIRED: 'Expired — not completed in time',
  SUPERSEDED: 'Superseded by a newer signing revision',
});

export const PARTY_TYPES = Object.freeze(['PLAYER', 'GUARDIAN', 'CLUB_SIGNATORY']);
export const PARTY_STATUSES = Object.freeze(['PENDING', 'COMPLETED']);
/** Only methods this build implements. An unknown method fails closed (§56). */
export const SIGNING_METHODS = Object.freeze(['PLATFORM_ACKNOWLEDGMENT', 'UPLOAD_EXECUTED_DOCUMENT']);
/** Who may be recorded as completing a party of each type. Never an agent, never a club user for a player (§13, §15). */
export const PARTY_ACTOR_KINDS = Object.freeze({ PLAYER: ['player'], GUARDIAN: ['guardian'], CLUB_SIGNATORY: ['org'] });

/** The minor signing pathway is CLOSED in every jurisdiction in this build (§14): a guardian-addressed Offer cannot open a package. */
export const MINOR_SIGNING_PATHWAY_ENABLED = Object.freeze({ GB: false, ENG: false, INT: false, USA: false, DEFAULT: false });
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export const minorSigningPathwayOpen = (jurisdiction, policy = MINOR_SIGNING_PATHWAY_ENABLED) =>
  (jurisdiction && has(policy, jurisdiction) ? policy[jurisdiction] === true : policy.DEFAULT === true);

export const SIGNING_LIMITS = Object.freeze({
  label: 120, internalNote: 2000, reason: 500, clientKey: 80,
  minExpiryMs: 60 * 60 * 1000, maxExpiryMs: 90 * DAY_MS, defaultExpiryMs: 30 * DAY_MS,
  maxContractYears: 10,
});

// ------------------------------------------------------------- helpers

/** Deep canonical serialisation (the P6.1 D-P61-1 lesson): every level key-sorted, never a replacer array. */
const canonical = (v) => {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]); return o; }
  return v === undefined ? null : v;
};
export const payloadFingerprint = (parts) => JSON.stringify(canonical(parts));

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
export function cleanText(raw, max) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  const v = raw.replace(CONTROL, '').replace(/\r\n?/g, '\n').trim();
  if (v.length > max) return { ok: false, tooLong: true };
  return { ok: true, value: v || null };
}

export function normaliseSigningClientKey(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, key: null };
  if (typeof raw !== 'string' || raw.length > SIGNING_LIMITS.clientKey || /[^\x21-\x7e]/.test(raw)) return { ok: false, error: 'SIGNING_CLIENT_KEY_INVALID', message: 'clientKey must be a short printable string.' };
  return { ok: true, key: raw };
}

/** Contract dates are DATE_ONLY days (P5.7), start ≤ end, and a plausible length. */
export function validateContractDates({ startDate, endDate } = {}) {
  const s = parseStrictDateOnly(startDate);
  if (!s.ok) return { ok: false, error: 'SIGNING_CONTRACT_DATES_INVALID', field: 'startDate', message: 'The contract start must be a real calendar day (YYYY-MM-DD).' };
  let end = null; let endT = null;
  if (endDate !== undefined && endDate !== null && endDate !== '') {
    const e = parseStrictDateOnly(endDate);
    if (!e.ok) return { ok: false, error: 'SIGNING_CONTRACT_DATES_INVALID', field: 'endDate', message: 'The contract end must be a real calendar day (YYYY-MM-DD).' };
    if (!isOrderedInterval(s.t, e.t, { allowEqual: true })) return { ok: false, error: 'SIGNING_CONTRACT_DATES_INVALID', field: 'endDate', message: 'The contract cannot end before it starts.' };
    if (e.t - s.t > SIGNING_LIMITS.maxContractYears * 366 * DAY_MS) return { ok: false, error: 'SIGNING_CONTRACT_DATES_INVALID', field: 'endDate', message: `A contract longer than ${SIGNING_LIMITS.maxContractYears} years cannot be recorded here.` };
    end = e.value; endT = e.t;
  }
  return { ok: true, contract: { startDate: s.value, endDate: end }, startT: s.t, endT };
}

/** A signing expiry: an instant, ≥ 1 h and ≤ 90 d from the request's server instant. Absent → the default. */
export function validateExpiry(raw, { now }) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, ms: now + SIGNING_LIMITS.defaultExpiryMs, defaulted: true };
  const p = parseInstant(raw);
  if (!p.ok) return { ok: false, error: 'SIGNING_EXPIRY_INVALID', message: 'The expiry must be an ISO 8601 instant with an offset or a millisecond timestamp.', expected: 'instant' };
  if (p.ms < now + SIGNING_LIMITS.minExpiryMs) return { ok: false, error: 'SIGNING_EXPIRY_INVALID', message: 'A signing must stay open for at least one hour.' };
  if (p.ms > now + SIGNING_LIMITS.maxExpiryMs) return { ok: false, error: 'SIGNING_EXPIRY_INVALID', message: 'A signing cannot stay open for more than 90 days.' };
  return { ok: true, ms: p.ms, defaulted: false };
}

/** The required parties for a package, snapshotted per revision (§16). A guardian recipient is refused upstream while the pathway is closed. */
export function requiredPartiesFor({ recipientType, playerId, guardianId = null, orgId }) {
  const parties = [];
  if (recipientType === 'guardian') parties.push({ partyType: 'GUARDIAN', forEntityId: guardianId, forPlayerId: playerId, status: 'PENDING', completedAt: null, completedBy: null, evidenceRef: null, method: null });
  else parties.push({ partyType: 'PLAYER', forEntityId: playerId, forPlayerId: playerId, status: 'PENDING', completedAt: null, completedBy: null, evidenceRef: null, method: null });
  parties.push({ partyType: 'CLUB_SIGNATORY', forEntityId: orgId, forPlayerId: playerId, status: 'PENDING', completedAt: null, completedBy: null, evidenceRef: null, method: null });
  return parties;
}

// ------------------------------------------------------------- reading

export const currentRevision = (pkg) => (pkg?.revisions ?? []).find((r) => r && r.id === pkg.currentRevisionId) ?? null;
export const nextRevisionNumber = (pkg) => (pkg?.revisions ?? []).reduce((m, r) => Math.max(m, Number.isInteger(r?.revisionNumber) ? r.revisionNumber : 0), 0) + 1;
export const isTerminal = (status) => SIGNING_TERMINAL.includes(status);
const LIVE = ['DRAFT', 'READY', 'IN_PROGRESS'];

/**
 * The package's status as the world reads it: the stored word, or EXPIRED when
 * a live package's expiry has passed at `now` (lazy, never written, §36). An
 * unknown stored word is not live and not anything else: null.
 */
export function effectiveStatus(pkg, now) {
  const st = pkg?.status;
  if (!SIGNING_STORED_STATUSES.includes(st)) return null;
  if (LIVE.includes(st)) {
    const exp = readInstant(pkg.expiresAt);
    if (exp !== null && isExpiredAt(exp, now)) return 'EXPIRED';
  }
  return st;
}
export const isLive = (pkg, now) => LIVE.includes(effectiveStatus(pkg, now));

const partiesOf = (rev) => (Array.isArray(rev?.requiredParties) ? rev.requiredParties : []);
export const partiesComplete = (rev) => partiesOf(rev).length > 0 && partiesOf(rev).every((p) => p && p.status === 'COMPLETED');
export const findParty = (rev, partyType, forEntityId = null) => partiesOf(rev).find((p) => p && p.partyType === partyType && (forEntityId === null || p.forEntityId === forEntityId)) ?? null;

// ------------------------------------------------------------- gates

/** May a package be opened over this Offer now? (§9) */
export function canStart({ offerStatus, offerRevisionStatus, caseStatus, recipientType, jurisdiction, existing = [] }, now) {
  // The most specific truth first: a completed or live package over this Offer names itself before the lifecycle does.
  const completed = existing.find((p) => effectiveStatus(p, now) === 'COMPLETED');
  if (completed) return { ok: false, error: 'SIGNING_ALREADY_COMPLETED', message: 'A completed signing already exists for this Offer.', current: { signingPackageId: completed.id } };
  const live = existing.find((p) => isLive(p, now));
  if (live) return { ok: false, error: 'SIGNING_PACKAGE_EXISTS', message: 'A signing is already open for this Offer.', current: { signingPackageId: live.id, status: effectiveStatus(live, now) } };
  if (offerStatus !== 'ACCEPTED' || offerRevisionStatus !== 'ACCEPTED') return { ok: false, error: 'SIGNING_OFFER_NOT_ACCEPTED', message: 'A signing can only be opened over an accepted Offer revision.' };
  if (caseStatus !== 'offer_accepted') return { ok: false, error: 'SIGNING_LIFECYCLE_CONFLICT', message: 'The case is not at Offer accepted.', current: { status: caseStatus ?? null } };
  if (recipientType === 'guardian' && !minorSigningPathwayOpen(jurisdiction)) return { ok: false, error: 'SIGNING_PATHWAY_CLOSED', message: 'Signing for a player under the age of majority is not open in this jurisdiction.' };
  if (recipientType !== 'player' && recipientType !== 'guardian') return { ok: false, error: 'SIGNING_RECIPIENT_INVALID', message: 'The Offer names no valid signatory.' };
  return { ok: true };
}

/** A refusal named after the state that stopped a mutation on a package the caller may read. */
export function stateRefusal(pkg, now, allowed) {
  const st = effectiveStatus(pkg, now);
  if (st === null) return { ok: false, error: 'SIGNING_STATE_UNKNOWN', message: 'This signing cannot be read.' };
  if (allowed.includes(st)) return { ok: true, status: st };
  const map = { EXPIRED: 'SIGNING_EXPIRED', CANCELLED: 'SIGNING_CANCELLED', VOIDED: 'SIGNING_VOIDED', COMPLETED: 'SIGNING_ALREADY_COMPLETED' };
  return { ok: false, error: map[st] ?? 'SIGNING_STATE_INVALID', message: `This signing is ${SIGNING_STATUS_LABELS[st] ?? st}.`, current: { status: st } };
}

export const canAttachDocument = (pkg, now) => stateRefusal(pkg, now, ['DRAFT']);
export const canCancel = (pkg, now) => stateRefusal(pkg, now, ['DRAFT', 'READY', 'IN_PROGRESS']);
export const canVoid = (pkg, now) => stateRefusal(pkg, now, ['READY', 'IN_PROGRESS']);
export const canSupersede = (pkg, now) => stateRefusal(pkg, now, ['READY', 'IN_PROGRESS']);

/** DRAFT → READY needs the exact document, valid contract dates and at least one required party (§43). */
export function canMarkReady(pkg, now) {
  const s = stateRefusal(pkg, now, ['DRAFT']);
  if (!s.ok) return s;
  const rev = currentRevision(pkg);
  if (!rev) return { ok: false, error: 'SIGNING_STATE_UNKNOWN', message: 'This signing cannot be read.' };
  if (!rev.document?.evidenceId || !rev.document?.sha256) return { ok: false, error: 'SIGNING_DOCUMENT_REQUIRED', message: 'Attach the exact document the parties will sign before presenting it.' };
  if (!rev.contract?.startDate) return { ok: false, error: 'SIGNING_CONTRACT_DATES_INVALID', field: 'startDate', message: 'The contract start day is required before presenting.' };
  if (!partiesOf(rev).length) return { ok: false, error: 'SIGNING_STATE_INVALID', message: 'No required party is recorded.' };
  return { ok: true, status: 'DRAFT' };
}

/**
 * May this actor complete this party on the current revision now? (§17, §39)
 * The actor is the authenticated session, never a body claim. A party is
 * completed against the exact current revision, whose digest the actor names.
 */
export function canCompleteParty(pkg, { partyType, actorKind, actorId, revisionId, documentSha256 }, now) {
  // P7.1: a confirmation that names a revision this package has already superseded is told so, whatever the package's
  // live state (a DRAFT awaiting re-presentation included) — the party's own act is what the answer is about.
  if (isLive(pkg, now) && revisionId !== pkg.currentRevisionId) {
    const older = (pkg.revisions ?? []).find((r) => r && r.id === revisionId && r.status === 'SUPERSEDED');
    if (older) return { ok: false, error: 'SIGNING_SUPERSEDED', message: 'That signing revision was replaced. Sign the current revision once it is presented.', current: { revisionId: pkg.currentRevisionId } };
  }
  const s = stateRefusal(pkg, now, ['READY', 'IN_PROGRESS']);
  if (!s.ok) return s;
  const rev = currentRevision(pkg);
  if (!rev) return { ok: false, error: 'SIGNING_STATE_UNKNOWN', message: 'This signing cannot be read.' };
  if (revisionId !== rev.id) {
    const old = (pkg.revisions ?? []).find((r) => r && r.id === revisionId);
    return old ? { ok: false, error: 'SIGNING_SUPERSEDED', message: 'That signing revision was replaced. Sign the current revision.', current: { revisionId: rev.id } } : { ok: false, error: 'SIGNING_INPUT_INVALID', field: 'revisionId', message: 'Name the signing revision you are completing.' };
  }
  if (!(PARTY_ACTOR_KINDS[partyType] ?? []).includes(actorKind)) return { ok: false, error: 'SIGNING_NOT_PERMITTED', message: 'You cannot sign for that party.' };
  const party = findParty(rev, partyType, partyType === 'CLUB_SIGNATORY' ? pkg.orgId : actorId);
  if (!party) return { ok: false, error: 'SIGNING_PARTY_NOT_REQUIRED', message: 'This signing does not require your signature.' };
  if (party.status === 'COMPLETED') return { ok: false, error: 'SIGNING_PARTY_ALREADY_COMPLETED', message: 'Your signature is already recorded on this revision.' };
  if (!rev.document?.sha256 || typeof documentSha256 !== 'string' || documentSha256.toLowerCase() !== String(rev.document.sha256).toLowerCase()) return { ok: false, error: 'SIGNING_DOCUMENT_MISMATCH', message: 'Confirm the exact document you read: its digest does not match the revision presented.' };
  return { ok: true, revision: rev, party };
}

/**
 * The completion gate (§22): every mandatory condition, all named. Only an
 * empty list lets the canonical completion run.
 */
export function completionGate(pkg, { now, offer, offerRevision, kase, otherCompleted = false, blocked = false, documentProblem = null }) {
  const problems = [];
  if (documentProblem) problems.push(`DOCUMENT_BYTES_${String(documentProblem).toUpperCase()}`);
  const st = effectiveStatus(pkg, now);
  if (st === null) problems.push('STATE_UNKNOWN');
  else if (st === 'COMPLETED') problems.push('ALREADY_COMPLETED');
  else if (st === 'EXPIRED') problems.push('EXPIRED');
  else if (!['READY', 'IN_PROGRESS'].includes(st)) problems.push(`STATE_${st}`);
  const rev = currentRevision(pkg);
  if (!rev) problems.push('REVISION_MISSING');
  else {
    if (!['READY', 'IN_PROGRESS'].includes(rev.status)) problems.push('REVISION_NOT_ACTIVE');
    if (!rev.document?.evidenceId || !rev.document?.sha256) problems.push('DOCUMENT_REQUIRED');
    if (!partiesComplete(rev)) problems.push('PARTIES_INCOMPLETE');
    for (const p of partiesOf(rev)) {
      if (p?.status !== 'COMPLETED') continue;
      if (!p.evidenceRef || !SIGNING_METHODS.includes(p.method)) problems.push('EVIDENCE_INVALID');
      if (p.evidenceRef?.documentSha256 && rev.document?.sha256 && p.evidenceRef.documentSha256 !== rev.document.sha256) problems.push('DOCUMENT_MISMATCH');
      const c = readInstant(p.completedAt); const r0 = readInstant(rev.readyAt ?? rev.createdAt);
      if (c === null || (r0 !== null && c < r0)) problems.push('TEMPORAL_ORDER');
    }
    if (!rev.contract?.startDate) problems.push('CONTRACT_DATES_INVALID');
  }
  if (!offer || offer.status !== 'ACCEPTED' || offer.id !== pkg.offerId) problems.push('OFFER_NOT_ACCEPTED');
  if (!offerRevision || offerRevision.id !== pkg.offerRevisionId || offerRevision.status !== 'ACCEPTED') problems.push('OFFER_REVISION_MISMATCH');
  if (offer && (offer.orgId !== pkg.orgId || offer.playerId !== pkg.playerId || offer.caseId !== pkg.caseId)) problems.push('REFERENCE_MISMATCH');
  if (!kase || kase.id !== pkg.caseId || kase.orgId !== pkg.orgId || kase.playerId !== pkg.playerId) problems.push('CASE_MISMATCH');
  else if (kase.room?.status !== 'offer_accepted') problems.push('LIFECYCLE_CONFLICT');
  if (otherCompleted) problems.push('CONFLICTING_COMPLETED_SIGNING');
  if (blocked) problems.push('BLOCKED');
  return problems;
}

// ------------------------------------------------------------- integrity

/**
 * Is this row a signing package this server could have written? Every
 * problem is named; a row with any is refused on read and on write, omitted
 * from every projection, and never repaired (the P6.1 rule).
 */
export function signingIntegrity(pkg, { orgId = null } = {}) {
  const problems = [];
  if (!pkg || typeof pkg !== 'object') return ['row'];
  if (typeof pkg.id !== 'string' || !pkg.id) problems.push('id');
  if (orgId !== null && pkg.orgId !== orgId) problems.push('org_mismatch');
  for (const k of ['orgId', 'playerId', 'caseId', 'offerId', 'offerRevisionId']) if (typeof pkg[k] !== 'string' || !pkg[k]) problems.push(k);
  if (!SIGNING_STORED_STATUSES.includes(pkg.status)) problems.push('status');
  const c0 = readInstant(pkg.createdAt);
  if (c0 === null) problems.push('created_at');
  const exp = readInstant(pkg.expiresAt);
  if (pkg.expiresAt !== null && pkg.expiresAt !== undefined && exp === null) problems.push('expires_at');
  if (exp !== null && c0 !== null && exp <= c0) problems.push('expiry_before_created');
  // P7.1 §42: a stored expiry no act could have set (beyond the maximum from the latest instant the package was worked on) is tampering, not a longer-lived package.
  if (exp !== null) {
    const worked = Math.max(c0 ?? 0, ...(Array.isArray(pkg.revisions) ? pkg.revisions.flatMap((r) => [readInstant(r?.createdAt) ?? 0, readInstant(r?.readyAt) ?? 0]) : [0]));
    if (worked > 0 && exp > worked + SIGNING_LIMITS.maxExpiryMs + DAY_MS) problems.push('expiry_beyond_max');
  }
  if (!Array.isArray(pkg.revisions) || pkg.revisions.length === 0) problems.push('revisions');
  else {
    const ids = new Set(); const nums = new Set();
    for (const r of pkg.revisions) {
      if (!r || typeof r.id !== 'string' || ids.has(r.id)) { problems.push('revision_id'); continue; }
      ids.add(r.id);
      if (!Number.isInteger(r.revisionNumber) || r.revisionNumber < 1 || nums.has(r.revisionNumber)) problems.push('revision_number');
      nums.add(r.revisionNumber);
      if (!SIGNING_REVISION_STATUSES.includes(r.status)) problems.push('revision_status');
      const rc = readInstant(r.createdAt); const rr = readInstant(r.readyAt); const rcomp = readInstant(r.completedAt);
      if (rc === null) problems.push('revision_created_at');
      if (rc !== null && c0 !== null && rc < c0) problems.push('revision_before_package');
      if (rr !== null && rc !== null && rr < rc) problems.push('ready_before_created');
      if (['READY', 'IN_PROGRESS', 'COMPLETED'].includes(r.status) && (rr === null || !r.document?.evidenceId || !r.document?.sha256)) problems.push('presented_without_document');
      if (!Array.isArray(r.requiredParties) || r.requiredParties.length === 0) problems.push('parties');
      else {
        // P7.1 §11: the required parties are the package's own — one recipient party (PLAYER or GUARDIAN), one CLUB_SIGNATORY,
        // each naming the package's player and club. Anything else is a party this server never wrote.
        const types = r.requiredParties.map((p) => p?.partyType);
        if (new Set(types).size !== types.length) problems.push('party_duplicate');
        if (!types.includes('PLAYER') && !types.includes('GUARDIAN')) problems.push('party_recipient_missing');
        if (types.includes('PLAYER') && types.includes('GUARDIAN')) problems.push('party_recipient_duplicate');
        if (!types.includes('CLUB_SIGNATORY')) problems.push('party_club_missing');
        for (const p of r.requiredParties) {
          if (!p || !PARTY_TYPES.includes(p.partyType) || !PARTY_STATUSES.includes(p.status)) { problems.push('party_shape'); continue; }
          if (p.forPlayerId !== undefined && p.forPlayerId !== pkg.playerId) problems.push('party_player_mismatch');
          if (p.partyType === 'PLAYER' && p.forEntityId !== pkg.playerId) problems.push('party_entity_mismatch');
          if (p.partyType === 'CLUB_SIGNATORY' && p.forEntityId !== pkg.orgId) problems.push('party_entity_mismatch');
          if (p.status === 'COMPLETED') {
            const pc = readInstant(p.completedAt);
            if (pc === null || !p.completedBy || !SIGNING_METHODS.includes(p.method) || !p.evidenceRef) problems.push('party_evidence');
            if (pc !== null && rr !== null && pc < rr) problems.push('party_before_ready');
            if (p.completedBy && !(PARTY_ACTOR_KINDS[p.partyType] ?? []).includes(p.completedBy.kind)) problems.push('party_actor_kind');
            // P7.1 §10: the evidence reference names THIS revision, THIS document's digest, THIS actor, at THIS instant.
            const ev = p.evidenceRef;
            if (ev && typeof ev === 'object') {
              if (ev.revisionId !== r.id) problems.push('party_evidence_revision');
              if (r.document?.sha256 && ev.documentSha256 !== r.document.sha256) problems.push('party_evidence_digest');
              if (p.completedBy && (ev.actorId !== p.completedBy.id || ev.actorKind !== p.completedBy.kind)) problems.push('party_evidence_actor');
              if (pc !== null && readInstant(ev.at) !== pc) problems.push('party_evidence_instant');
            }
          } else if (p.completedAt || p.completedBy || p.evidenceRef) problems.push('party_pending_with_evidence');
        }
      }
      if (r.status === 'COMPLETED') {
        if (!partiesComplete(r)) problems.push('completed_without_parties');
        const maxParty = Math.max(...partiesOf(r).map((p) => readInstant(p?.completedAt) ?? 0));
        if (rcomp === null || rcomp < maxParty) problems.push('completed_before_parties');
      }
      if (r.contract && r.contract.startDate && !parseStrictDateOnly(r.contract.startDate).ok) problems.push('contract_dates');
      if (r.contract && r.contract.endDate && !parseStrictDateOnly(r.contract.endDate).ok) problems.push('contract_dates');
    }
    if (typeof pkg.currentRevisionId !== 'string' || !ids.has(pkg.currentRevisionId)) problems.push('current_revision');
    else {
      const cur = pkg.revisions.find((r) => r && r.id === pkg.currentRevisionId);
      if (cur && pkg.revisions.some((r) => r && r !== cur && Number.isInteger(r.revisionNumber) && r.revisionNumber > cur.revisionNumber)) problems.push('current_revision_not_latest');
      if (cur && pkg.status === 'COMPLETED' && cur.status !== 'COMPLETED') problems.push('completed_package_revision_mismatch');
    }
  }
  if (pkg.status === 'COMPLETED' && (!pkg.completion || typeof pkg.completion.signingId !== 'string' || readInstant(pkg.completion.completedAt) === null)) problems.push('completion');
  if (pkg.status !== 'COMPLETED' && pkg.completion) problems.push('completion_without_status');
  return problems;
}

/** ACCEPTED-Offer coupling (§65, §66): a package whose Offer or case contradicts it is corruption. */
export function signingConsistency(pkg, { offer, kase, rows = null, player = null }, now) {
  const problems = [];
  const st = effectiveStatus(pkg, now);
  // P7.1 §32–§33: the completed-signing record and the package agree, or the package is corruption; the player's own
  // contract status is a projection that may lawfully move (they can declare a later change), so a divergence is a warning.
  if (Array.isArray(rows)) {
    const mine = rows.filter((s) => s && s.signingPackageId === pkg.id);
    if (st === 'COMPLETED' && mine.length === 0) problems.push('COMPLETED_WITHOUT_ROW');
    if (mine.length > 1) problems.push('DUPLICATE_SIGNING_ROWS');
    if (st !== 'COMPLETED' && mine.length > 0) problems.push('ROW_WITHOUT_COMPLETION');
    if (st === 'COMPLETED' && pkg.completion?.signingId && !mine.some((s) => s.id === pkg.completion.signingId)) problems.push('COMPLETION_ROW_MISMATCH');
  }
  if (player && st === 'COMPLETED' && player.contractStatus !== 'under_contract') problems.push('PLAYER_CONTRACT_STATUS_DIVERGED');
  if (offer && (offer.orgId !== pkg.orgId || offer.playerId !== pkg.playerId || offer.caseId !== pkg.caseId)) problems.push('OFFER_REFERENCE_MISMATCH');
  if (kase && (kase.orgId !== pkg.orgId || kase.playerId !== pkg.playerId)) problems.push('CASE_REFERENCE_MISMATCH');
  // §9, §66 (#7): the package is bound to the ACCEPTED Offer revision. A binding to a revision the Offer does not hold,
  // one that was superseded or withdrawn, or one whose answer was not an acceptance, is a package this server never wrote.
  const revs = Array.isArray(offer?.revisions) ? offer.revisions : null;
  if (revs && revs.length) {
    const bound = revs.find((r) => r && r.id === pkg.offerRevisionId) ?? null;
    const answer = bound ? (Array.isArray(offer.responses) ? offer.responses.find((x) => x && x.revisionId === bound.id) ?? null : null) : null;
    const stale = !bound || !!bound.supersededByRevisionId || !!bound.withdrawnAt || (answer && answer.responseType !== 'accepted') || (typeof bound.status === 'string' && !['ACCEPTED', 'ISSUED'].includes(bound.status));
    if (stale) problems.push('OFFER_REVISION_MISMATCH');
  }
  if (st === 'COMPLETED' && kase && kase.room?.status !== 'signed') problems.push('COMPLETED_BUT_CASE_NOT_SIGNED');
  if (st && st !== 'COMPLETED' && LIVE.includes(st) && kase && kase.room?.status !== 'offer_accepted') problems.push('LIVE_SIGNING_CASE_NOT_AT_OFFER_ACCEPTED');
  return problems;
}
export const SIGNING_CORRUPTION = Object.freeze(['OFFER_REFERENCE_MISMATCH', 'CASE_REFERENCE_MISMATCH', 'OFFER_REVISION_MISMATCH', 'COMPLETED_BUT_CASE_NOT_SIGNED', 'COMPLETED_WITHOUT_ROW', 'DUPLICATE_SIGNING_ROWS', 'ROW_WITHOUT_COMPLETION', 'COMPLETION_ROW_MISMATCH']);
export const signingCorrupt = (problems) => (problems ?? []).some((p) => SIGNING_CORRUPTION.includes(p));

// ------------------------------------------------------------- views

const actorView = (a) => (a ? { kind: a.kind ?? null, name: a.name ?? null } : null);
const partyView = (p, { forClub }) => ({
  partyType: p.partyType, status: p.status, completedAt: p.completedAt ?? null, method: p.method ?? null,
  // Who completed is identity: the club sees its own signatory and the fact of the player's act; a recipient sees the kinds only.
  completedBy: forClub ? actorView(p.completedBy) : (p.completedBy ? { kind: p.completedBy.kind ?? null, name: null } : null),
});
const documentView = (d) => (d ? { id: d.id ?? null, label: d.label ?? null, filename: d.filename ?? null, mime: d.mime ?? null, bytes: d.bytes ?? null, sha256: d.sha256 ?? null } : null);
function revisionView(r, { forClub }) {
  return {
    id: r.id, revisionNumber: r.revisionNumber, status: r.status, statusLabel: SIGNING_STATUS_LABELS[r.status] ?? null,
    createdAt: r.createdAt ?? null, readyAt: r.readyAt ?? null, completedAt: r.completedAt ?? null,
    document: documentView(r.document), executedDocument: documentView(r.executedDocument),
    contract: r.contract ? { startDate: r.contract.startDate ?? null, endDate: r.contract.endDate ?? null } : null,
    requiredParties: partiesOf(r).map((p) => partyView(p, { forClub })),
    supersedesRevisionId: r.supersedesRevisionId ?? null, supersededByRevisionId: r.supersededByRevisionId ?? null,
    ...(forClub ? { createdBy: actorView(r.createdBy), readyBy: actorView(r.readyBy) } : {}),
  };
}

/** What the recipient must do next, if anything. */
export function nextActionFor(pkg, now, { partyType, forEntityId }) {
  const st = effectiveStatus(pkg, now);
  if (!['READY', 'IN_PROGRESS'].includes(st)) return null;
  const rev = currentRevision(pkg);
  const p = findParty(rev, partyType, forEntityId);
  if (!p || p.status !== 'PENDING') return null;
  return { action: 'COMPLETE_SIGNATURE', revisionId: rev.id, documentSha256: rev.document?.sha256 ?? null };
}

export function signingClubView(pkg, now, { orgName = null } = {}) {
  const st = effectiveStatus(pkg, now);
  const rev = currentRevision(pkg);
  return {
    id: pkg.id, orgId: pkg.orgId, orgName, caseId: pkg.caseId, playerId: pkg.playerId, offerId: pkg.offerId, offerRevisionId: pkg.offerRevisionId, transactionId: pkg.transactionId ?? null,
    status: st, storedStatus: pkg.status, statusLabel: SIGNING_STATUS_LABELS[st] ?? null, terminal: isTerminal(st),
    currentRevisionId: pkg.currentRevisionId, currentRevision: rev ? revisionView(rev, { forClub: true }) : null,
    revisions: (pkg.revisions ?? []).map((r) => revisionView(r, { forClub: true })),
    expiresAt: pkg.expiresAt ?? null, internalNote: pkg.internalNote ?? null,
    completion: pkg.completion ? { signingId: pkg.completion.signingId, completedAt: pkg.completion.completedAt, contract: pkg.completion.contract ?? null, lifecycle: pkg.completion.lifecycle ?? null } : null,
    cancelledAt: pkg.cancelledAt ?? null, cancelReason: pkg.cancelReason ?? null, voidedAt: pkg.voidedAt ?? null, voidReason: pkg.voidReason ?? null,
    createdAt: pkg.createdAt, createdBy: actorView(pkg.createdBy), updatedAt: pkg.updatedAt ?? pkg.createdAt, rev: Number.isInteger(pkg.rev) ? pkg.rev : 1,
    policyVersion: pkg.policyVersion ?? SIGNING_POLICY_VERSION,
    honest: 'ScoutBox records the signing workflow and the evidence each party gives against the exact document. It does not execute the agreement and claims no legal effect beyond what it records.',
  };
}

/** The recipient reads the package only from READY (§42, §43): the exact presented revision, never a draft, never the note. */
export function signingRecipientView(pkg, now, { orgName = null, partyType, forEntityId } = {}) {
  const st = effectiveStatus(pkg, now);
  const presented = (pkg.revisions ?? []).filter((r) => r && r.readyAt);
  const rev = currentRevision(pkg);
  return {
    id: pkg.id, playerId: pkg.playerId, club: { id: pkg.orgId, name: orgName }, offerId: pkg.offerId, offerRevisionId: pkg.offerRevisionId,
    status: st, statusLabel: SIGNING_STATUS_LABELS[st] ?? null, terminal: isTerminal(st),
    currentRevisionId: rev?.readyAt ? rev.id : null,
    currentRevision: rev?.readyAt ? revisionView(rev, { forClub: false }) : null,
    revisions: presented.map((r) => revisionView(r, { forClub: false })),
    expiresAt: pkg.expiresAt ?? null,
    nextAction: nextActionFor(pkg, now, { partyType, forEntityId }),
    completion: pkg.completion ? { completedAt: pkg.completion.completedAt, contract: pkg.completion.contract ?? null } : null,
    policyVersion: pkg.policyVersion ?? SIGNING_POLICY_VERSION,
    honest: 'Completing your signature here records that you, as the authenticated account holder, confirm the exact document shown. ScoutBox records the workflow and the evidence; it does not execute the agreement for you.',
  };
}

/** The agent reads state and progress of a package over an Offer the client shared: no document bytes, no note, no signatory identity beyond the kind (§53). */
export function signingAgentView(pkg, now, { orgName = null } = {}) {
  const st = effectiveStatus(pkg, now);
  const rev = currentRevision(pkg);
  return {
    id: pkg.id, clientId: pkg.playerId, club: { id: pkg.orgId, name: orgName }, offerId: pkg.offerId,
    status: st, statusLabel: SIGNING_STATUS_LABELS[st] ?? null, terminal: isTerminal(st),
    currentRevisionNumber: rev?.revisionNumber ?? null, presented: !!rev?.readyAt, expiresAt: pkg.expiresAt ?? null,
    requiredParties: rev ? partiesOf(rev).map((p) => ({ partyType: p.partyType, status: p.status, completedAt: p.completedAt ?? null })) : [],
    clientActionRequired: !!nextActionFor(pkg, now, { partyType: 'PLAYER', forEntityId: pkg.playerId }),
    contract: rev?.contract ? { startDate: rev.contract.startDate ?? null, endDate: rev.contract.endDate ?? null } : null,
    completedAt: pkg.completion?.completedAt ?? null,
    honest: 'Read-only. Your client signs as themselves; ScoutBox does not let you sign, acknowledge or complete for a client.',
  };
}

export function signingHistoryView(pkg, { forRecipient = false } = {}) {
  const items = (pkg?.history ?? []).filter((h) => h && (!forRecipient || !/draft|note|internal/.test(h.action)));
  return items.map((h) => ({ id: h.id, at: h.at, action: h.action, by: forRecipient ? { kind: h.by?.kind ?? null, name: h.by?.kind === 'org' ? null : h.by?.name ?? null } : actorView(h.by), revisionId: h.detail?.revisionId ?? null }));
}

/**
 * The completed signing record (`db.signings`), shaped so every existing
 * reader keeps working (`ts`, `playerName`, `orgName`, `userId`, `scoutName`,
 * `insideAttributionWindow`) and every P7 fact is on it by reference: the
 * package, the revision, the Offer, the case, the document digest, the
 * contract days, the method and the parties' provenance summary. Never a
 * term, never a fee, never the note.
 */
export function completedSigningRecord({ id, pkg, rev, player, org, actor, at, attribution }) {
  return {
    id, playerId: player.id, playerName: player.name ?? null, orgId: org.id, orgName: org.name ?? null,
    userId: actor?.id ?? null, scoutName: actor?.name ?? null,
    ts: at, signedAt: at,
    firstQualifyingInteraction: attribution?.first ?? null, attributionWindowMonths: attribution?.windowMonths ?? null, insideAttributionWindow: !!attribution?.inside,
    method: 'CANONICAL_COMPLETION',
    signingPackageId: pkg.id, signingRevisionId: rev.id, signingRevisionNumber: rev.revisionNumber,
    caseId: pkg.caseId, offerId: pkg.offerId, offerRevisionId: pkg.offerRevisionId, transactionId: pkg.transactionId ?? null,
    documentSha256: rev.document?.sha256 ?? null, documentEvidenceId: rev.document?.evidenceId ?? null, executedDocumentEvidenceId: rev.executedDocument?.evidenceId ?? null,
    contract: rev.contract ? { startDate: rev.contract.startDate ?? null, endDate: rev.contract.endDate ?? null } : null,
    parties: partiesOf(rev).map((p) => ({ partyType: p.partyType, method: p.method, completedAt: p.completedAt, byKind: p.completedBy?.kind ?? null })),
    policyVersion: SIGNING_POLICY_VERSION,
  };
}
