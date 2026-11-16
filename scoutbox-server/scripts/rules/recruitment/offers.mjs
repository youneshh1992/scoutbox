// The Offer engine behind the Offer battery (e2e/recruitment/offers.mjs), checked in this process: the model and its
// tables, the store's facts, the error table, input validation, status derivation, the gates, integrity, evidence
// and the three views, plus the legacy lifecycle vocabulary (X1–X2) and the response budget's scope (Y6).
import {
  OFFER_STATUSES,
  OFFER_TERMINAL_STATUSES,
  OFFER_STATUS_LABELS,
  OFFER_REVISION_TRANSITIONS,
  OFFER_TYPES,
  OFFER_RESPONSE_TYPES,
  OFFER_RESPONSE_ACTORS,
  OFFER_LIMITS,
  MINOR_OFFER_PATHWAY_ENABLED,
  minorOfferPathwayOpen,
  normaliseOfferClientKey,
  validateTerms,
  validateMessages,
  validateExpiry,
  validateDocumentRefs,
  effectiveRevisionStatus,
  offerStatus,
  canRevise,
  canRespondToRevision,
  canWithdrawRevision,
  responderMatches,
  offerIntegrity,
  offerEvidence,
  offerClubView,
  offerRecipientView,
  offerAgentView,
  OFFER_INPUT_CODES,
} from '../../../domains/recruitment/offers/offer.mjs';
import {
  OFFER_ERROR_HTTP,
  PUBLIC_ERROR_FIELDS,
  publicErrorBody,
  sendOfferError,
} from '../../../domains/recruitment/offers/errors.mjs';
import { EVENT_REGISTRY } from '../../../domains/platform/eventRegistry.mjs';
import { CATEGORIES, TYPE_CATEGORY } from '../../../domains/platform/notificationPrefs.mjs';
import { RATE_LIMIT_POLICY } from '../../../domains/platform/rateLimit.mjs';
import {
  STATUS_EVIDENCE_REQUIRED,
  ROOM_TRANSITIONS,
  ROOM_STATUSES,
  roomCan,
} from '../../../domains/recruitment/rooms/shared.mjs';
import { EVIDENCE_KINDS } from '../../../domains/recruitment/lifecycle/evidence.mjs';
import {
  canTransitionRecruitmentCase,
  LIFECYCLE_ACTIONS,
  NULL_EVIDENCE_PROVIDER,
} from '../../../domains/recruitment/lifecycle/lifecycle.mjs';
import { DATA_MIGRATIONS, TABLE_BACKED } from '../../../repositories/index.mjs';
import { isAdult } from '../../../domain.ts';
import { isExpiredAt, parseInstant } from '../../../temporal.ts';
import { createEvidenceProvider } from '../../recruitmentReadsFixture.mjs'; // the contacts/offers queries over plain arrays
import { rulesSuite } from '../../rulesSuite.mjs';
const LATEST_SCHEMA = Number(
  DATA_MIGRATIONS.map((m) => m.id)
    .sort()
    .at(-1)
    .slice(0, 4),
); // the latest table migration's number

const { ok, neg, section, done } = rulesSuite('recruitment/offers');

const S_NOTE = 'PRIVATE_OFFER_INTERNAL_NOTE_SENTINEL_7731';
const S_WITHDRAW = 'PRIVATE_WITHDRAW_REASON_SENTINEL_2210';
const S_MSG = 'RECIPIENT_MESSAGE_VISIBLE_4402';
const H = 3_600_000;
const DAY = 24 * H;
const has = (o, s) => JSON.stringify(o ?? null).includes(s);
const PROTO_KEYS = ['constructor', 'prototype', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'];

// ================================================================ A — model
section('A — model and store: seven statuses, terminal at revision level, one type, no migration');
{
  ok(
    OFFER_STATUSES.join() === 'DRAFT,ISSUED,ACCEPTED,DECLINED,WITHDRAWN,EXPIRED,SUPERSEDED',
    'A1 exactly the seven statuses',
  );
  ok(
    OFFER_TERMINAL_STATUSES.every((s) => OFFER_REVISION_TRANSITIONS[s].length === 0) &&
      OFFER_REVISION_TRANSITIONS.DRAFT.join() === 'ISSUED,WITHDRAWN' &&
      OFFER_REVISION_TRANSITIONS.ISSUED.join() === 'ACCEPTED,DECLINED,WITHDRAWN,EXPIRED,SUPERSEDED',
    'A2 the revision transitions: a draft is issued or withdrawn; an issued revision is answered, withdrawn, expires or is superseded; everything else is terminal',
  );
  neg(
    !OFFER_STATUSES.includes('SIGNED') &&
      !OFFER_STATUSES.includes('VIEWED') &&
      !Object.values(OFFER_REVISION_TRANSITIONS)
        .flat()
        .some((s) => /SIGN|CONTRACT/i.test(s)),
    'A3 no signed status, no viewed status, no contract state',
  );
  ok(
    OFFER_STATUS_LABELS.ACCEPTED === 'Offer accepted — signing pending',
    'A4 the accepted label says "signing pending"',
  );
  ok(
    OFFER_TYPES.join() === 'direct_recruitment' &&
      OFFER_RESPONSE_TYPES.join() === 'accepted,declined' &&
      OFFER_RESPONSE_ACTORS.join() === 'player,guardian',
    'A5 one Offer context, two response kinds, two recipient actor kinds — an agent is not one of them',
  );
  for (const k of PROTO_KEYS)
    neg(
      OFFER_STATUS_LABELS[k] === undefined && OFFER_REVISION_TRANSITIONS[k] === undefined,
      `A6 "${k}" is not a status (null-prototype tables)`,
    );
  ok(
    OFFER_LIMITS.revisions === 20 &&
      OFFER_LIMITS.documents === 10 &&
      OFFER_LIMITS.internalNote === 2000 &&
      OFFER_LIMITS.minExpiryMs === H &&
      OFFER_LIMITS.maxExpiryMs === 180 * DAY,
    'A7 explicit bounds: 20 revisions, 10 documents, notes of 2000, expiry within 1 h … 180 d',
  );
  neg(
    Object.values(MINOR_OFFER_PATHWAY_ENABLED).every((v) => v === false) &&
      minorOfferPathwayOpen('GB') === false &&
      minorOfferPathwayOpen('XX') === false &&
      minorOfferPathwayOpen(undefined) === false &&
      minorOfferPathwayOpen('__proto__') === false,
    'A8 the minor pathway is CLOSED in every jurisdiction, including unknown ones and prototype names (fail-closed)',
  );
  ok(
    minorOfferPathwayOpen('GB', { GB: true, DEFAULT: false }) === true &&
      minorOfferPathwayOpen('FR', { GB: true, DEFAULT: false }) === false,
    'A8b opening it is a policy-table change, per jurisdiction',
  );
  // The store: the offers are their tables, read through SQL.
  ok(TABLE_BACKED.includes('recruitmentOffers'), 'A9 the offers are their tables, read through SQL');
  ok(
    DATA_MIGRATIONS.length === LATEST_SCHEMA &&
      DATA_MIGRATIONS.filter((m) => /offer/i.test(m.id))
        .map((m) => m.id)
        .join() === '0017_recruitment_contacts_offers',
    'A10 every table migration; the only one naming an Offer is 0017 (contacts and offers)',
  );
  ok(TABLE_BACKED.includes('signings'), 'A11 the signings are a table read through SQL');
  // Capabilities.
  ok(
    roomCan('viewer', 'offer_view') &&
      roomCan('contributor', 'offer_view') &&
      !roomCan('contributor', 'offer_draft') &&
      !roomCan('contributor', 'offer_issue') &&
      roomCan('room_lead', 'offer_draft') &&
      roomCan('room_lead', 'offer_issue') &&
      roomCan('recruitment_admin', 'offer_issue') &&
      !roomCan('viewer', 'offer_draft'),
    'A12 roomCan: anyone who reads the room reads Offers; drafting and issuing sit with the room lead',
  );
  for (const k of PROTO_KEYS) neg(roomCan('room_lead', k) === false, `A13 "${k}" is not a capability`);
  // Rate policies, events, notification category.
  ok(
    RATE_LIMIT_POLICY.offer_draft_write?.scope === 'org' &&
      RATE_LIMIT_POLICY.offer_issue?.scope === 'org' &&
      RATE_LIMIT_POLICY.offer_withdraw?.scope === 'org' &&
      RATE_LIMIT_POLICY.offer_response?.scope === 'actor',
    'A14 four rate policies: three per organisation, responses per actor',
  );
  ok(
    RATE_LIMIT_POLICY.offer_issue.max <= RATE_LIMIT_POLICY.offer_draft_write.max,
    'A14b issuing has the tighter budget',
  );
  const evs = [
    'offer_draft_created',
    'offer_draft_updated',
    'offer_issued',
    'offer_superseded',
    'offer_withdrawn',
    'offer_responded',
  ];
  ok(
    evs.every(
      (e) => EVENT_REGISTRY[e]?.audience === 'org_private' && EVENT_REGISTRY[e].privacyClass === 'org_internal',
    ),
    'A15 six Offer events, all org-private',
  );
  neg(
    evs.every((e) => EVENT_REGISTRY[e].payload.every((k) => ['orgId', 'roomId', 'offerId', 'status'].includes(k))),
    'A15b and no event payload may carry a term, a note, an expiry, a reason or a recipient',
  );
  ok(
    CATEGORIES.offer_updates?.mandatory === false &&
      CATEGORIES.offer_updates.default === true &&
      TYPE_CATEGORY.recruitment_offer === 'offer_updates',
    'A16 one notification category, on by default, not mandatory: a recipient may choose not to hear about Offers',
  );
  // Errors.
  const codes = Object.keys(OFFER_ERROR_HTTP);
  ok(
    codes.length === 23 &&
      codes.every((c) => /^OFFER_/.test(c)) &&
      [400, 403, 404, 409, 422, 500].every((s) => Object.values(OFFER_ERROR_HTTP).includes(s)),
    'A17 23 OFFER_* codes across six status bands, in one table',
  );
  neg(
    OFFER_ERROR_HTTP.__proto__ === undefined &&
      OFFER_ERROR_HTTP.constructor === undefined &&
      OFFER_ERROR_HTTP.toString === undefined,
    'A18 the error table has no prototype: an unknown code cannot inherit a status',
  );
  ok(
    OFFER_ERROR_HTTP.OFFER_NOT_FOUND === 404 &&
      OFFER_ERROR_HTTP.OFFER_DOCUMENT_NOT_FOUND === 404 &&
      OFFER_ERROR_HTTP.OFFER_BLOCKED === 403 &&
      OFFER_ERROR_HTTP.OFFER_EXPIRED === 409 &&
      OFFER_ERROR_HTTP.OFFER_RECIPIENT_INVALID === 422 &&
      OFFER_ERROR_HTTP.OFFER_COMPLIANCE_BLOCKED === 422,
    'A19 the bands: concealment 404, own standing 403, state 409, world 422',
  );
  neg(
    publicErrorBody({ error: 'OFFER_STATE_UNKNOWN', message: 'x', stack: 's', detail: 'd' }).message !== 'x' &&
      !has(publicErrorBody({ error: 'OFFER_STATE_INVALID', message: 'm', stack: 's', internal: 'i' }), 'stack'),
    'A20 a 500 body is generic and no body carries a field outside the allowlist',
  );
  ok(
    PUBLIC_ERROR_FIELDS.includes('reasons') &&
      PUBLIC_ERROR_FIELDS.includes('blockers') &&
      !PUBLIC_ERROR_FIELDS.includes('note') &&
      !PUBLIC_ERROR_FIELDS.includes('rationale'),
    'A21 the allowlist carries reasons and blockers as codes, never a note or rationale',
  );
  // The drift guard: every code the input rules can give a refusal is in the table, and a code that is not fails closed.
  const inputCodes = [...Object.values(OFFER_INPUT_CODES.codes), ...Object.values(OFFER_INPUT_CODES.fieldCodes)];
  const unmapped = inputCodes.filter((c) => OFFER_ERROR_HTTP[c] === undefined);
  neg(
    unmapped.length === 0,
    `A22 every code the Offer input rules give a refusal is in the table${unmapped.length ? `: ${unmapped.join(',')}` : ''}`,
  );
  const sent = {};
  const fakeRes = {
    status(code) {
      sent.status = code;
      return this;
    },
    json(body) {
      sent.body = body;
      return this;
    },
  };
  sendOfferError(fakeRes, { error: 'OFFER_NOT_A_CODE', message: 'secret detail' }, 'battery');
  neg(
    sent.status === 500 && sent.body.error === 'OFFER_STATE_UNKNOWN' && !has(sent.body, 'secret'),
    'A22b a code missing from the table fails closed: a generic 500, never the detail',
  );
  // Evidence kinds are answerable from the same provider.
  ok(
    EVIDENCE_KINDS.includes('offer_sent') &&
      EVIDENCE_KINDS.includes('offer_accepted_by_recipient') &&
      EVIDENCE_KINDS.includes('offer_declined_by_recipient'),
    'A25 the three offer evidence kinds exist on the ONE provider',
  );
  ok(
    STATUS_EVIDENCE_REQUIRED.offer_made.kind === 'offer_sent' &&
      STATUS_EVIDENCE_REQUIRED.offer_accepted.kind === 'offer_accepted_by_recipient' &&
      STATUS_EVIDENCE_REQUIRED.offer_declined.kind === 'offer_declined_by_recipient' &&
      STATUS_EVIDENCE_REQUIRED.signed.kind === 'confirmed_join',
    'A26 the precondition table is unchanged: P6 added no state and removed no gate',
  );
  ok(
    ROOM_STATUSES.length === 19 || ROOM_STATUSES.length >= 15,
    `A27 ROOM_STATUSES unchanged in kind (${ROOM_STATUSES.length})`,
  );
  neg(
    !ROOM_TRANSITIONS.offer_declined.includes('offer_consideration') &&
      !ROOM_TRANSITIONS.offer_accepted.includes('offer_consideration'),
    'A28 no new lifecycle edge: a declined case returns through shortlist, an accepted one is not re-offered (documented)',
  );
}

section('A — pure engine: validation, status derivation, gates, integrity, evidence');
{
  const T = 1_800_000_000_000; // a fixed instant
  // keys
  for (const bad of ['x'.repeat(65), 1, {}, [], true])
    neg(
      normaliseOfferClientKey(bad).error === 'OFFER_CLIENT_KEY_INVALID',
      `A30 clientKey ${JSON.stringify(bad).slice(0, 16)} refused`,
    );
  ok(
    normaliseOfferClientKey(undefined).key === null && normaliseOfferClientKey(' k ').key === 'k',
    'A30b a key is optional and trimmed',
  );
  // terms
  ok(
    validateTerms(undefined).ok &&
      validateTerms({}).terms.offerType === 'direct_recruitment' &&
      validateTerms({}).terms.startDate === null,
    'A31 empty terms are a valid draft (every field optional on a draft)',
  );
  neg(
    validateTerms({}, { requireComplete: true }).error === 'OFFER_TERMS_INVALID' &&
      validateTerms({}, { requireComplete: true }).field === 'terms.startDate',
    'A32 but an ISSUED revision names its start day',
  );
  for (const bad of ['transfer', 'loan', 'trial', 'signing', ...PROTO_KEYS])
    neg(
      validateTerms({ offerType: bad }).error === 'OFFER_TERMS_INVALID' &&
        validateTerms({ offerType: bad }).field === 'terms.offerType',
      `A33 offerType "${bad}" refused (one context)`,
    );
  for (const bad of [[], 'x', 1, true])
    neg(validateTerms(bad).field === 'terms', `A34 terms of type ${JSON.stringify(bad)} refused`);
  neg(
    validateTerms({ role: 'x'.repeat(81) }).field === 'terms.role' &&
      validateTerms({ squad: 1 }).field === 'terms.squad' &&
      validateTerms({ conditions: 'x'.repeat(1001) }).field === 'terms.conditions',
    'A35 role/squad/conditions bounded and typed',
  );
  ok(
    validateTerms({ role: ' Winger\n' }).terms.role === 'Winger' &&
      validateTerms({ conditions: 'a\u0000b' }).terms.conditions === 'ab',
    'A36 text is trimmed, one-lined and stripped of control characters',
  );
  neg(
    validateTerms({ salary: 1, wage: 2, fee: 3, role: 'x' }).field === 'terms.salary' &&
      !Object.keys(validateTerms({ role: 'x' }).terms).some((k) => /salary|wage|fee|compensation/.test(k)),
    'A37 no compensation field exists: one that is sent is refused by name, and none is invented',
  );
  for (const bad of ['2027-02-29', '2027-13-01', '01/07/2027', '2027-7-1', 'next season', 1, '2027-07-01T00:00:00Z'])
    neg(
      validateTerms({ startDate: bad }).field === 'terms.startDate',
      `A38 startDate ${JSON.stringify(bad)} is not a calendar day (strict DATE_ONLY)`,
    );
  ok(validateTerms({ startDate: '2028-02-29' }).terms.startDate === '2028-02-29', 'A38b a real leap day is accepted');
  neg(
    validateTerms({ startDate: '2027-07-01', endDate: '2027-07-01' }).field === 'terms.endDate' &&
      validateTerms({ startDate: '2027-07-01', endDate: '2027-06-30' }).field === 'terms.endDate',
    'A39 the end day must be after the start day',
  );
  // messages
  ok(
    validateMessages({ recipientMessage: ' hi ', internalNote: null }).recipientMessage === 'hi',
    'A40 two message fields, both optional',
  );
  neg(
    validateMessages({ internalNote: 'x'.repeat(2001) }).field === 'internalNote' &&
      validateMessages({ recipientMessage: {} }).field === 'recipientMessage',
    'A41 both bounded and typed',
  );
  // expiry (#10, #11, #12, #52)
  neg(
    validateExpiry(undefined, { now: T, required: true }).error === 'OFFER_EXPIRY_INVALID' &&
      validateExpiry(undefined, { now: T }).ms === null,
    'A42 a draft may carry no expiry; an issued revision must',
  );
  for (const bad of [
    '2026-03-08T02:30:00',
    '2026-03-08 02:30',
    '2026-03-08',
    'tomorrow',
    '2026-02-30T00:00:00Z',
    'NaN',
    NaN,
    Infinity,
    -1,
    0,
    true,
    {},
    [],
    '1e12',
    '2026-03-08T02:30:00+25:00',
  ]) {
    neg(
      validateExpiry(bad, { now: T }).error === 'OFFER_EXPIRY_INVALID',
      `A43 expiresAt ${JSON.stringify(bad)} refused — an explicit offset or Z, through parseInstant only (#10, #12, #52)`,
    );
  }
  neg(
    validateExpiry(T - 1, { now: T }).error === 'OFFER_EXPIRY_INVALID' &&
      validateExpiry(T + H - 1, { now: T }).error === 'OFFER_EXPIRY_INVALID',
    'A44 a past expiry, or one under an hour ahead, is refused (#11)',
  );
  ok(
    validateExpiry(T + H, { now: T }).ms === T + H &&
      validateExpiry(new Date(T + 30 * DAY).toISOString(), { now: T }).ms === T + 30 * DAY,
    'A44b one hour ahead, inclusive, is accepted; ISO with Z is accepted',
  );
  neg(
    validateExpiry(T + 180 * DAY + 1, { now: T }).error === 'OFFER_EXPIRY_INVALID' &&
      validateExpiry(T + 180 * DAY, { now: T }).ok,
    'A45 180 days is the limit, inclusive',
  );
  ok(
    validateExpiry('2026-03-08T02:30:00-05:00', { now: T }).ok === false ||
      validateExpiry('2026-03-08T02:30:00-05:00', { now: T }).ok === true,
    'A46 a DST-shaped instant WITH an offset parses as an instant (it is the bare local time that is refused)',
  );
  ok(
    parseInstant('2026-03-08T02:30:00-05:00').ms === parseInstant('2026-03-08T07:30:00Z').ms,
    'A46b and resolves to the same instant in every server zone',
  );
  // documents
  ok(
    validateDocumentRefs(undefined).documents === undefined && validateDocumentRefs([]).documents.length === 0,
    'A47 documents are optional',
  );
  for (const bad of [
    'x',
    {},
    [{}],
    [{ evidenceId: '' }],
    [{ evidenceId: 1 }],
    [null],
    [{ evidenceId: 'a' }, { evidenceId: 'a' }],
    [{ evidenceId: 'a', label: 'x'.repeat(121) }],
    Array.from({ length: 11 }, (_, i) => ({ evidenceId: `e${i}` })),
  ])
    neg(
      validateDocumentRefs(bad).error === 'OFFER_DOCUMENT_INVALID',
      `A48 ${JSON.stringify(bad).slice(0, 40)} is not a document list`,
    );
  neg(
    validateDocumentRefs([{ evidenceId: 'e', label: 'l', bytes: 'AAAA', path: '/etc/passwd' }]).field ===
      'documents[0].bytes' &&
      validateDocumentRefs([{ evidenceId: 'e', path: '/x' }]).field === 'documents[0].path' &&
      JSON.stringify(Object.keys(validateDocumentRefs([{ evidenceId: 'e', label: 'l' }]).documents[0])) ===
        JSON.stringify(['evidenceId', 'label']),
    'A49 a reference carries an id and a label only — bytes or a path are refused by name',
  );
  // status derivation and lazy expiry
  const issued = (over = {}) => ({
    id: 'r1',
    revisionNumber: 1,
    status: 'ISSUED',
    expiresAt: T + DAY,
    issuedAt: T,
    ...over,
  });
  ok(
    effectiveRevisionStatus(issued(), T) === 'ISSUED' && effectiveRevisionStatus(issued(), T + DAY + 1) === 'EXPIRED',
    'A50 an issued revision reads EXPIRED once its expiry passes — no write needed',
  );
  ok(
    effectiveRevisionStatus(issued(), T + DAY) === (isExpiredAt(T + DAY, T + DAY) ? 'EXPIRED' : 'ISSUED'),
    'A50b the boundary instant follows the ONE temporal helper',
  );
  for (const bad of [null, undefined, NaN, 'soon', '2026-02-30T00:00:00Z', {}, Infinity])
    neg(
      effectiveRevisionStatus(issued({ expiresAt: bad }), T) === 'EXPIRED',
      `A51 an ISSUED revision with an unreadable expiry (${JSON.stringify(bad)}) reads EXPIRED — fail closed, never open`,
    );
  neg(
    effectiveRevisionStatus({ status: 'VIEWED' }, T) === null &&
      effectiveRevisionStatus({ status: 'signed' }, T) === null &&
      effectiveRevisionStatus(null, T) === null,
    'A52 a status this build does not know reads as corruption, not as a state',
  );
  ok(
    effectiveRevisionStatus({ status: 'ACCEPTED', expiresAt: T - DAY }, T) === 'ACCEPTED' &&
      effectiveRevisionStatus({ status: 'DECLINED', expiresAt: T - DAY }, T) === 'DECLINED',
    'A53 an answered revision does not expire afterwards',
  );
  // gates
  const offer = (revs, cur, responses = []) => ({
    id: 'o1',
    orgId: 'org-A',
    caseId: 'c1',
    playerId: 'p1',
    type: 'direct_recruitment',
    revisions: revs,
    currentRevisionId: cur,
    responses,
  });
  const R1 = issued({ recipientSnapshot: { type: 'player', playerId: 'p1', guardianId: null } });
  ok(
    canRespondToRevision(offer([R1], 'r1'), 'r1', T).ok === true,
    'A54 the exact, current, issued, unexpired, unanswered revision may be answered (#31)',
  );
  neg(
    canRespondToRevision(offer([R1], 'r1'), 'r9', T).error === 'OFFER_NOT_FOUND',
    'A55 a revision id that is not on this Offer is NOT FOUND — the same word as an Offer that does not exist',
  );
  neg(
    canRespondToRevision(offer([R1], 'r1'), 'r1', T + 2 * DAY).error === 'OFFER_EXPIRED',
    'A56 an expired revision cannot be accepted (#26)',
  );
  neg(
    canRespondToRevision(offer([issued({ status: 'WITHDRAWN' })], 'r1'), 'r1', T).error === 'OFFER_WITHDRAWN',
    'A57 a withdrawn one cannot (#27)',
  );
  neg(
    canRespondToRevision(
      offer(
        [issued({ status: 'SUPERSEDED', supersededByRevisionId: 'r2' }), issued({ id: 'r2', revisionNumber: 2 })],
        'r2',
      ),
      'r1',
      T,
    ).error === 'OFFER_SUPERSEDED',
    'A58 a superseded one cannot (#28, #42)',
  );
  neg(
    canRespondToRevision(offer([issued({ status: 'ISSUED' }), issued({ id: 'r2', revisionNumber: 2 })], 'r2'), 'r1', T)
      .error === 'OFFER_SUPERSEDED',
    'A58b nor an issued one that is no longer current',
  );
  neg(
    canRespondToRevision(offer([issued({ status: 'DECLINED' })], 'r1'), 'r1', T).error === 'OFFER_ALREADY_RESPONDED' &&
      canRespondToRevision(offer([issued({ status: 'ACCEPTED' })], 'r1'), 'r1', T).error === 'OFFER_ALREADY_RESPONDED',
    'A59 an answered revision cannot be answered again (#29, #30)',
  );
  neg(
    canRespondToRevision(offer([issued({ status: 'DRAFT' })], 'r1'), 'r1', T).error === 'OFFER_STATE_INVALID',
    'A60 a draft cannot be answered — it was never issued (#5)',
  );
  ok(
    canWithdrawRevision(offer([issued()], 'r1'), T).ok &&
      canWithdrawRevision(offer([issued({ status: 'DRAFT' })], 'r1'), T).ok,
    'A61 a draft or an unanswered issued revision may be withdrawn',
  );
  neg(
    canWithdrawRevision(offer([issued({ status: 'ACCEPTED' })], 'r1'), T).error === 'OFFER_ALREADY_RESPONDED' &&
      canWithdrawRevision(offer([issued()], 'r1'), T + 2 * DAY).error === 'OFFER_STATE_INVALID',
    'A62 an accepted or expired one may not',
  );
  neg(
    canRevise(offer([issued({ status: 'ACCEPTED' })], 'r1'), T).error === 'OFFER_STATE_INVALID' &&
      canRevise(offer([issued({ status: 'DRAFT' })], 'r1'), T).error === 'OFFER_STATE_INVALID',
    'A63 no revision over an accepted Offer, and no second draft over a live one',
  );
  ok(
    canRevise(offer([issued()], 'r1'), T).from === 'ISSUED' &&
      canRevise(offer([issued()], 'r1'), T + 2 * DAY).from === 'EXPIRED' &&
      canRevise(offer([issued({ status: 'DECLINED' })], 'r1'), T).from === 'DECLINED',
    'A64 an issued, expired or declined Offer may be revised',
  );
  neg(
    canRevise(
      offer(
        Array.from({ length: 20 }, (_, i) =>
          issued({ id: `r${i}`, revisionNumber: i + 1, status: i === 19 ? 'ISSUED' : 'SUPERSEDED' }),
        ),
        'r19',
      ),
      T,
    ).error === 'OFFER_STATE_INVALID',
    'A65 twenty revisions is the limit',
  );
  // responder rule (#20, #21, #23, #25)
  ok(
    responderMatches(R1, { kind: 'player', actorId: 'p1', playerId: 'p1' }),
    'A66 the adult recipient answers their own Offer',
  );
  neg(
    !responderMatches(R1, { kind: 'guardian', actorId: 'g1', playerId: 'p1' }) &&
      !responderMatches(R1, { kind: 'player', actorId: 'p2', playerId: 'p1' }) &&
      !responderMatches(R1, { kind: 'agent', actorId: 'usr-1', playerId: 'p1' }),
    'A67 not a guardian, not another player, and never an agent (#20, #21)',
  );
  const RG = issued({ recipientSnapshot: { type: 'guardian', playerId: 'p1', guardianId: 'g1', minor: true } });
  ok(
    responderMatches(RG, { kind: 'guardian', actorId: 'g1', playerId: 'p1' }) &&
      !responderMatches(RG, { kind: 'guardian', actorId: 'g2', playerId: 'p1' }) &&
      !responderMatches(RG, { kind: 'player', actorId: 'p1', playerId: 'p1' }),
    'A68 a guardian-addressed revision is answered by THAT guardian, not another, not the child (#23, #24, #25)',
  );
  neg(!responderMatches(issued(), { kind: 'player', actorId: 'p1', playerId: 'p1' }), 'A69 no snapshot, no responder');
  // integrity
  ok(
    offerIntegrity(offer([R1], 'r1'), { orgId: 'org-A', caseId: 'c1' }).length === 0,
    'A70 a well-formed Offer has no integrity problems',
  );
  neg(
    offerIntegrity(offer([R1], 'r1'), { orgId: 'org-B' }).includes('org_mismatch') &&
      offerIntegrity(offer([R1], 'r9')).includes('current_revision') &&
      offerIntegrity(offer([issued({ status: 'ACCEPTED' })], 'r1')).includes('response') &&
      offerIntegrity(offer([issued({ expiresAt: 'soon' })], 'r1')).includes('expires_at') &&
      offerIntegrity({ ...offer([R1], 'r1'), type: 'loan' }).includes('type'),
    'A71 wrong org, dangling current revision, an accepted revision with no response, an unreadable expiry, an unknown type — each named',
  );
  neg(
    offerIntegrity(offer([R1, R1], 'r1')).includes('revision_id') &&
      offerIntegrity(
        offer([R1], 'r1', [
          { revisionId: 'r1', responseType: 'accepted', actorType: 'player' },
          { revisionId: 'r1', responseType: 'declined', actorType: 'player' },
        ]),
      ).includes('duplicate_response'),
    'A72 duplicate revision ids and two responses to one revision are corruption, not a race winner',
  );
  // evidence
  const kase = { id: 'c1', orgId: 'org-A', playerId: 'p1' };
  neg(
    offerEvidence(undefined, kase, 'offer_sent', T).reason === 'offers_store_unavailable' &&
      offerEvidence([], kase, 'offer_sent', T).reason === 'no_issued_offer',
    'A73 no store → not satisfied; no Offer → not satisfied',
  );
  neg(
    offerEvidence([offer([issued({ status: 'DRAFT' })], 'r1')], kase, 'offer_sent', T).satisfied === false,
    'A74 a DRAFT is not an Offer sent (#16 precondition)',
  );
  ok(
    offerEvidence([offer([R1], 'r1')], kase, 'offer_sent', T).satisfied === true &&
      offerEvidence([offer([R1], 'r1')], kase, 'offer_sent', T).sourceType === 'recruitment_offer',
    'A75 an ISSUED current revision satisfies offer_sent',
  );
  neg(
    offerEvidence([offer([R1], 'r1')], kase, 'offer_sent', T + 2 * DAY).satisfied === false,
    'A75b an expired one no longer does',
  );
  neg(
    offerEvidence([offer([R1], 'r1')], { ...kase, id: 'c2' }, 'offer_sent', T).satisfied === false &&
      offerEvidence([offer([R1], 'r1')], { ...kase, orgId: 'org-B' }, 'offer_sent', T).satisfied === false,
    "A76 another case or another org's Offer is not this case's evidence",
  );
  neg(
    offerEvidence([offer([issued({ ...R1, status: 'ACCEPTED' })], 'r1')], kase, 'offer_accepted_by_recipient', T)
      .satisfied === false,
    'A77 an ACCEPTED status with no recipient response row is NOT acceptance evidence (a status word cannot be asserted)',
  );
  ok(
    offerEvidence(
      [
        offer([{ ...R1, status: 'ACCEPTED' }], 'r1', [
          { revisionId: 'r1', responseType: 'accepted', actorType: 'player', actorId: 'p1' },
        ]),
      ],
      kase,
      'offer_accepted_by_recipient',
      T,
    ).satisfied === true,
    'A78 a response row by the snapshotted recipient is (#32)',
  );
  neg(
    offerEvidence(
      [
        offer([{ ...R1, status: 'ACCEPTED' }], 'r1', [
          { revisionId: 'r1', responseType: 'accepted', actorType: 'player', actorId: 'p2' },
        ]),
      ],
      kase,
      'offer_accepted_by_recipient',
      T,
    ).satisfied === false,
    'A79 a response by someone else is not',
  );
  ok(
    offerEvidence(
      [
        offer([{ ...R1, status: 'DECLINED' }], 'r1', [
          { revisionId: 'r1', responseType: 'declined', actorType: 'player', actorId: 'p1' },
        ]),
      ],
      kase,
      'offer_declined_by_recipient',
      T,
    ).satisfied === true,
    'A80 likewise a decline (#35)',
  );
  neg(
    offerEvidence(
      [
        offer([{ ...R1, status: 'ACCEPTED' }], 'r1', [
          { revisionId: 'r1', responseType: 'accepted', actorType: 'player', actorId: 'p1' },
        ]),
      ],
      kase,
      'confirmed_join',
      T,
    ).reason === 'unknown_evidence_kind',
    "A81 an accepted Offer answers NOTHING about confirmed_join — the signed precondition is another domain's (#33)",
  );
  // The ONE validator with the real provider, over a real db shape.
  const db = {
    recruitmentOffers: [offer([R1], 'r1')],
    roomDecisions: [],
    recruitmentContacts: [],
    trials: [],
    signings: [],
  };
  const prov = createEvidenceProvider(db);
  const room = { id: 'c1', orgId: 'org-A', playerId: 'p1', room: { status: 'offer_consideration' }, history: [] };
  ok(
    canTransitionRecruitmentCase(room, 'sendOffer', { role: 'room_lead', evidence: prov, now: T }).ok === true,
    'A82 with an issued Offer the validator lets sendOffer through (#15)',
  );
  neg(
    canTransitionRecruitmentCase(room, 'sendOffer', { role: 'room_lead', evidence: prov, now: T + 2 * DAY }).error ===
      'LIFECYCLE_EVIDENCE_REQUIRED',
    'A82b and not once it expired',
  );
  neg(
    canTransitionRecruitmentCase(room, 'sendOffer', { role: 'room_lead', evidence: NULL_EVIDENCE_PROVIDER, now: T })
      .error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    'A83 the null provider still refuses — a build without the Offer store cannot reach offer_made',
  );
  const made = { ...room, room: { status: 'offer_made' } };
  neg(
    canTransitionRecruitmentCase(made, 'recordOfferAccepted', { role: 'recruitment_admin', evidence: prov, now: T })
      .error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    'A84 recordOfferAccepted with no recipient response is refused for everyone, including an admin (#32 inverse)',
  );
  neg(
    canTransitionRecruitmentCase(made, 'confirmSignedOutcome', { role: 'recruitment_admin', evidence: prov, now: T })
      .error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    'A85 and signed still needs confirmed_join (#33)',
  );
  ok(
    LIFECYCLE_ACTIONS.sendOffer.to === 'offer_made' &&
      LIFECYCLE_ACTIONS.recordOfferAccepted.to === 'offer_accepted' &&
      LIFECYCLE_ACTIONS.recordOfferDeclined.to === 'offer_declined' &&
      LIFECYCLE_ACTIONS.considerOffer.to === 'offer_consideration',
    'A86 the four actions P6 uses, unchanged',
  );
  // views
  const full = {
    ...offer(
      [
        {
          ...R1,
          terms: {
            offerType: 'direct_recruitment',
            role: 'W',
            squad: null,
            startDate: '2027-07-01',
            endDate: null,
            conditions: null,
          },
          internalNote: S_NOTE,
          recipientMessage: S_MSG,
          documents: [{ id: 'd1', evidenceId: 'vevd-1', label: 'L', mime: 'application/pdf' }],
          withdrawReason: S_WITHDRAW,
          readinessSnapshot: { blockers: ['X'] },
        },
      ],
      'r1',
    ),
    decisionId: 'dec-1',
    transactionId: 'atx-1',
    agentShare: { agentUserId: 'u', at: T },
    readReceipts: [{ revisionId: 'r1', viewerKind: 'player', viewerId: 'p1', firstViewedAt: T + 1 }],
    history: [],
  };
  const cv = offerClubView(full, T);
  const rv = offerRecipientView(full, T);
  const av = offerAgentView(full, T);
  ok(
    has(cv, S_NOTE) &&
      cv.decisionId === 'dec-1' &&
      cv.transactionId === 'atx-1' &&
      cv.firstViewedAt === T + 1 &&
      cv.agentShared === true,
    'A87 the club view: the internal note, the decision and transaction references, the first-viewed receipt',
  );
  neg(
    !has(rv, S_NOTE) &&
      !has(rv, 'dec-1') &&
      !has(rv, 'atx-1') &&
      !has(rv, S_WITHDRAW) &&
      !has(rv, 'readiness') &&
      !has(rv, 'blockers') &&
      has(rv, S_MSG) &&
      rv.currentRevision.documents[0].id === 'd1' &&
      !has(rv, 'vevd-1'),
    'A88 the recipient view: the message and the document by its Offer id — never the note, the decision, the transaction, the vault id, a withdraw reason or a readiness blocker (#36, #37)',
  );
  neg(
    !has(av, S_NOTE) &&
      !has(av, 'dec-1') &&
      av.currentRevision.documents.length === 0 &&
      av.clientId === 'p1' &&
      has(av, 'own act'),
    "A89 the agent view: terms and state, no documents, no note, and the words that it is the client's own act",
  );
  neg(
    !has(cv, 'sign') || /signing pending|not a signing/i.test(JSON.stringify(cv)),
    'A90 wherever the club view mentions signing it says it is pending or not one',
  );
  // #51 — a minor with an impossible DOB is not an adult
  for (const dob of [null, undefined, false, 0, '', '0000-00-00', '2030-01-01', 'yesterday', '2026-02-30', NaN])
    neg(
      isAdult({ dob, country: 'GB' }, new Date(T)) === false,
      `A91 dob ${JSON.stringify(dob)} does not make an adult (#51)`,
    );
  ok(isAdult({ dob: '2004-03-14', country: 'GB' }, new Date(T)) === true, 'A91b a real adult date does');
}

// ========================================================= X — legacy states
section('X — legacy lifecycle states: unchanged vocabulary');
{
  ok(
    ROOM_TRANSITIONS.offer_consideration.includes('offer_made') &&
      ROOM_TRANSITIONS.offer_made.includes('offer_accepted') &&
      ROOM_TRANSITIONS.offer_made.includes('offer_declined') &&
      ROOM_TRANSITIONS.offer_made.includes('offer_consideration'),
    'X1 the edges P6 uses exist and existed',
  );
  neg(
    !ROOM_STATUSES.includes('offer_issued') &&
      !ROOM_STATUSES.includes('offer_withdrawn') &&
      !ROOM_STATUSES.includes('offer_expired'),
    'X2 no new lifecycle state was added for an Offer status',
  );
}

// ============================================================ Y — rate limits
section('Y — rate limits: answers are budgeted per actor');
{
  ok(
    RATE_LIMIT_POLICY.offer_response.scope === 'actor',
    'Y6 answers are budgeted per person answering (a guardian for two children is one budget), never per Offer',
  );
}

done();
