// S8c test fixtures: recruitment contacts and offers in the EXACT shapes the writers produce (m23/contactRoutes.mjs the
// draft :319-335, the external record :598-611, the send :453-508, the response hook :628-639, the edit :371-398;
// m28/index.mjs the offer :326-340, the edit :384-394, the issue :460-479, the withdraw :516-527, the revise :569-580,
// the response :742-772, the share :796-809, the receipt :654, the deletion unit :894-896). Synthetic ids and names only.
// Shared by testRecruitmentContactsOffers.mjs and testRecruitmentContactsOffersServer.mjs. The ids agree with the S8a
// and S8b fixtures: case-1 is the room of pl-adult (req-p4b), case-2 the case of pl-child1 (req-minor, guardian
// gd-primary), case-gone the tombstoned case of the historically missing pl-gone-long-ago.
import { NOW } from './coreIdentityTestFixtures.mjs';
import { ORG, SCOUT, p4bInvitation } from './recruitmentTestFixtures.mjs';

const MIN = 60_000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
export const TX = Object.freeze({ drafted: NOW - 6 * DAY, sent: NOW - 5 * DAY, answered: NOW - 4 * DAY, issued: NOW - 3 * DAY, revised: NOW - 2 * DAY, accepted: NOW - DAY, removed: NOW });
const ACTOR = Object.freeze({ kind: 'org', userId: SCOUT.userId, name: SCOUT.name }); // contactRoutes.mjs:55 actorOf(req)
const REVBY = Object.freeze({ userId: SCOUT.userId, name: SCOUT.name }); // m181/concurrency.mjs:84 bumpRev
const BY = Object.freeze({ kind: 'org', id: SCOUT.userId, name: SCOUT.name, role: SCOUT.role }); // m28/index.mjs:77 byOrg(req)
export const HONEST_AGENT = 'Who was validly routed when this contact was recorded. A later change to the relationship does not rewrite it, and the next contact is routed from the authority in force then.';
export const HONEST_NONE = 'Routed to the recipient only: no agent authority could be resolved when this was sent.';
export const PRIVATE_BODY = 'Internal: we would like to talk about next season.';
export const PRIVATE_NOTE = 'Internal: hold until the winter window.';

/** contactRoutes.mjs:61-64 `record()` — a contact history entry. */
export const chist = (id, at, action, detail = null, by = ACTOR) => ({ id, at, action, by, detail });
/** The thirty-six-key contact literal (the in-app draft, contactRoutes.mjs:319-335). */
export const draftContact = (over = {}) => ({
  id: 'rct-1', orgId: ORG.id, caseId: 'case-1', playerId: 'pl-adult', status: 'draft', channel: 'in_app', recipient: null, contactMode: 'player_only', routingSnapshot: null,
  subject: 'Next season', body: PRIVATE_BODY, summary: null, createdBy: ACTOR, createdAt: TX.drafted, updatedAt: TX.drafted,
  sentBy: null, sentAt: null, deliveredAt: null, failedAt: null, failureCode: null, attempts: [], requestId: null, emailCopy: null, lifecycle: null,
  occurredAt: null, recordedBy: null, recordedAt: null, respondedAt: null, response: null, cancelledAt: null, cancelledBy: null,
  keys: { create: { key: 'k-create-1', fp: '{"body":"x","contactMode":"player_only","subject":"Next season"}' }, send: null, record: null },
  history: [chist('aud-rc1', TX.drafted, 'contact_created', { channel: 'in_app', contactMode: 'player_only' })], rev: 1, revAt: TX.drafted, revBy: REVBY, policyVersion: 1, ...over,
});
/** Sent after one failed attempt, routed to the agent, the courtesy copy in the local outbox, answered by the guardian (pl-child1's case; req-minor). */
export const respondedContact = (over = {}) => draftContact({
  id: 'rct-2', caseId: 'case-2', playerId: 'pl-child1', status: 'responded', recipient: { type: 'guardian', playerId: 'pl-child1', guardianId: 'gd-primary', minor: true }, contactMode: 'both',
  routingSnapshot: { at: TX.sent, mode: 'both', player: true, guardian: true, agent: { agentUserId: SCOUT.userId, agreementId: 'rep-1' }, honest: HONEST_AGENT },
  subject: null, body: 'Trial talk', updatedAt: TX.answered, sentBy: ACTOR, sentAt: TX.sent, deliveredAt: TX.sent,
  attempts: [{ at: TX.sent - MIN, ok: false, code: 'TRANSPORT_REFUSED' }, { at: TX.sent, ok: true, code: null }], requestId: 'req-minor',
  emailCopy: { state: 'local_outbox', to: 'guardian', outboxId: 'mail-7', at: TX.sent + 1 }, lifecycle: { applied: true, from: 'contact_planned', to: 'contacted', at: TX.sent },
  respondedAt: TX.answered, response: { kind: 'accepted', message: 'Yes please', by: 'guardian', at: TX.answered },
  keys: { create: null, send: { key: 'k-send-2', fp: '{"contactId":"rct-2"}' }, record: null },
  history: [chist('aud-rc2', TX.drafted, 'contact_created', { channel: 'in_app', contactMode: 'both' }), chist('aud-rc3', TX.sent - MIN, 'contact_send_failed', { code: 'TRANSPORT_REFUSED', attempt: 1 }), chist('aud-rc4', TX.sent, 'contact_sent', { channel: 'in_app', recipientType: 'guardian', attempt: 2, mode: 'both', agentParty: true }), chist('aud-rc5', TX.answered, 'contact_responded', { kind: 'accepted' }, { kind: 'guardian', name: 'Guardian' })],
  rev: 3, revAt: TX.answered, revBy: null, ...over,
});
/** Delivered with a NULL send key (contactRoutes.mjs:453 `key.key ?? null`), the copy not available, the agent refused, the lifecycle not applied (pl-adult; req-p4b). */
export const nullKeyContact = (over = {}) => draftContact({
  id: 'rct-3', status: 'delivered', recipient: { type: 'player', playerId: 'pl-adult', guardianId: null, minor: false }, contactMode: 'both',
  routingSnapshot: { at: TX.sent, mode: 'player_only', player: true, guardian: false, agent: null, honest: HONEST_NONE }, subject: 'S', body: 'B',
  sentBy: ACTOR, sentAt: TX.sent, deliveredAt: TX.sent, attempts: [{ at: TX.sent, ok: true, code: null }], requestId: 'req-p4b',
  emailCopy: { state: 'not_available', to: 'guardian', outboxId: null, at: TX.sent }, lifecycle: { applied: false, reason: 'LIFECYCLE_NO_CHANGE', at: TX.sent },
  keys: { create: { key: 'k-c3', fp: 'fp3' }, send: { key: null, fp: '{"contactId":"rct-3"}' }, record: null },
  history: [chist('aud-rc6', TX.sent, 'contact_sent', { channel: 'in_app', recipientType: 'player', attempt: 1, mode: 'player_only', agentParty: false }), chist('aud-rc7', TX.sent, 'contact_agent_routing_refused', { reasonCode: 'NO_REPRESENTATION' })], ...over,
});
/** The attested external record (contactRoutes.mjs:598-611) with a prototype-named own key inside a history detail. */
export const externalContact = (over = {}) => draftContact({
  id: 'rct-4', caseId: 'case-2', playerId: 'pl-child1', status: 'recorded', channel: 'phone', recipient: { type: 'player', playerId: 'pl-child1', guardianId: null, minor: false }, subject: null, body: null, summary: 'Spoke on the phone.',
  lifecycle: { applied: true, from: 'contact_planned', to: 'contacted', at: TX.sent }, occurredAt: TX.sent - HOUR, recordedBy: ACTOR, recordedAt: TX.sent,
  keys: { create: null, send: null, record: { key: 'k-rec-4', fp: 'fp-rec' } },
  history: [chist('aud-rc8', TX.sent, 'contact_external_recorded', Object.defineProperty({ channel: 'phone', occurredAt: TX.sent - HOUR, recipientType: 'player' }, '__proto__', { value: { planted: true }, enumerable: true, writable: true, configurable: true }))], ...over,
});
/** A pre-P5.6E literal: NO contactMode / routingSnapshot keys at all; cancelled; an unknown top-level key kept. */
export const legacyContact = (over = {}) => { const c = draftContact({ id: 'rct-5', caseId: 'case-gone', playerId: 'pl-gone-long-ago', status: 'cancelled', subject: 'Old', body: 'Old body', updatedAt: TX.drafted + MIN, cancelledAt: TX.drafted + MIN, cancelledBy: ACTOR, keys: { create: null, send: null, record: null }, history: [chist('aud-rc9', TX.drafted + MIN, 'contact_cancelled')], legacyFlag: 'kept', ...over }); delete c.contactMode; delete c.routingSnapshot; return c; };
/** Off-type values the blob store accepts (a string rev, a numeric subject, an object where a list is expected; an unknown empty list act). */
export const offtypeContact = (over = {}) => draftContact({ id: 'rct-8', caseId: 'case-2', playerId: 'pl-child1', subject: 42, attempts: { not: 'a list' }, keys: { create: null, send: null, record: null, strange: [] }, history: [], rev: '1', ...over });

export const TERMS = Object.freeze({ offerType: 'direct_recruitment', role: 'CM', squad: 'U21', startDate: '2027-07-01', endDate: null, conditions: null });
/** m28/index.mjs:78-81 `hist()` — an offer history entry. */
export const ohist = (id, at, action, detail = null, by = { kind: 'org', id: SCOUT.userId, name: SCOUT.name }) => ({ id, at, action, by, detail });
/** m28/index.mjs:326-333 — a revision literal (every key present; `discardedByResponseId` absent unless discarded). */
export const revision = (over = {}) => ({ id: 'rofr-1', revisionNumber: 1, status: 'DRAFT', terms: TERMS, recipientMessage: null, internalNote: PRIVATE_NOTE, documents: [], expiresAt: null, createdAt: TX.drafted, createdBy: BY, updatedAt: TX.drafted, updatedBy: BY, issuedAt: null, issuedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: null, respondedAt: null, response: null, supersedesRevisionId: null, supersededByRevisionId: null, supersededAt: null, recipientSnapshot: null, readinessSnapshot: null, rev: 1, revAt: TX.drafted, revBy: null, ...over });
/** m28/index.mjs:334-340 — the draft offer literal. */
export const draftOffer = (over = {}) => ({
  id: 'rof-1', orgId: ORG.id, caseId: 'case-1', playerId: 'pl-adult', type: 'direct_recruitment', decisionId: 'rdec-2', transactionId: null, status: 'DRAFT', currentRevisionId: 'rofr-1',
  revisions: [revision()], responses: [], readReceipts: [], agentShare: null,
  keys: { create: { key: 'k-o1', fp: '{"documents":[],"expiresAt":null,"internalNote":"n","recipientMessage":null,"terms":{}}' }, issue: [], withdraw: [], revise: [] },
  lifecycle: null, history: [ohist('aud-ro1', TX.drafted, 'offer_draft_created', { revisionId: 'rofr-1', revisionNumber: 1 })], createdAt: TX.drafted, createdBy: BY, updatedAt: TX.drafted, rev: 1, revAt: TX.drafted, revBy: null, policyVersion: 1, ...over,
});
/** Issued with documents and a readiness snapshot, superseded by revision 2, revision 2 accepted while draft revision 3 beside it was discarded; shared with the agent; read receipts; the subject removed. */
export const acceptedOffer = (over = {}) => draftOffer({
  id: 'rof-2', caseId: 'case-2', playerId: 'pl-child1', decisionId: 'rdec-missing', transactionId: 'atx-1', status: 'ACCEPTED', currentRevisionId: 'rofr-3',
  revisions: [
    revision({ id: 'rofr-2', status: 'SUPERSEDED', recipientMessage: 'Welcome', internalNote: null, documents: [{ id: 'rofd-1', evidenceId: 'ver-1', label: 'Terms sheet', mime: 'application/pdf', bytes: 1234 }, { id: 'rofd-2', evidenceId: 'ver-2', label: null, mime: null, bytes: null }], expiresAt: TX.issued + 30 * DAY, updatedAt: TX.issued, issuedAt: TX.issued, issuedBy: BY, supersededByRevisionId: 'rofr-3', supersededAt: TX.revised, recipientSnapshot: { type: 'guardian', playerId: 'pl-child1', guardianId: 'gd-primary', minor: true, at: TX.issued }, readinessSnapshot: { transactionId: 'atx-1', evaluatedAt: TX.issued, status: 'ACTIVE', blockers: [] }, rev: 2, revAt: TX.issued, revBy: REVBY }),
    revision({ id: 'rofr-3', revisionNumber: 2, status: 'ACCEPTED', terms: { ...TERMS, squad: 'First team' }, recipientMessage: 'Revised', internalNote: 'n2', documents: [{ id: 'rofd-3', evidenceId: 'ver-1', label: 'Terms sheet', mime: 'application/pdf', bytes: 1234 }], expiresAt: TX.revised + 30 * DAY, createdAt: TX.revised, updatedAt: TX.revised, issuedAt: TX.revised, issuedBy: BY, respondedAt: TX.accepted, response: { id: 'rofa-1' }, supersedesRevisionId: 'rofr-2', recipientSnapshot: { type: 'guardian', playerId: 'pl-child1', guardianId: 'gd-primary', minor: true, at: TX.revised }, rev: 3, revAt: TX.accepted }),
    revision({ id: 'rofr-4', revisionNumber: 3, status: 'WITHDRAWN', createdAt: TX.revised + HOUR, updatedAt: TX.revised + HOUR, withdrawnAt: TX.accepted, supersedesRevisionId: 'rofr-3', discardedByResponseId: 'rofa-1' }),
  ],
  responses: [{ id: 'rofa-1', revisionId: 'rofr-3', responseType: 'accepted', actorType: 'guardian', actorId: 'gd-primary', actorName: null, forPlayerId: 'pl-child1', occurredAt: TX.accepted, reason: null, clientKey: 'ck-accept' }],
  readReceipts: [{ revisionId: 'rofr-2', viewerKind: 'guardian', viewerId: 'gd-primary', firstViewedAt: TX.issued + HOUR }, { revisionId: 'rofr-3', viewerKind: 'guardian', viewerId: 'gd-primary', firstViewedAt: TX.revised + HOUR }],
  agentShare: { agentUserId: SCOUT.userId, agreementId: 'rep-9', at: TX.revised + 2 * HOUR, by: { kind: 'player', id: 'pl-child1' } },
  keys: { create: { key: 'k-o2', fp: 'fp' }, issue: [{ key: 'k-issue-1', revisionId: 'rofr-2' }, { key: 'k-issue-2', revisionId: 'rofr-3' }], withdraw: [], revise: [{ key: 'k-rev-2', revisionId: 'rofr-3' }, { key: 'k-rev-3', revisionId: 'rofr-4' }] },
  lifecycle: { applied: true, action: 'recordOfferAccepted', from: 'offer_made', to: 'offer_accepted', at: TX.accepted },
  history: [ohist('aud-ro2', TX.issued, 'offer_issued', { revisionId: 'rofr-2', revisionNumber: 1, supersedes: null, expiresAt: TX.issued + 30 * DAY }), ohist('aud-ro3', TX.issued + HOUR, 'offer_viewed', { revisionId: 'rofr-2' }, { kind: 'guardian', id: 'gd-primary', name: null }), ohist('aud-ro4', TX.accepted, 'offer_draft_discarded', { revisionId: 'rofr-4', byResponseId: 'rofa-1' }, { kind: 'guardian', id: 'gd-primary', name: null }), ohist('aud-ro5', TX.accepted, 'offer_accepted', { revisionId: 'rofr-3', responseId: 'rofa-1', hadReason: false }, { kind: 'guardian', id: 'gd-primary', name: null })],
  updatedAt: TX.accepted, rev: 6, revAt: TX.accepted, revBy: null, subjectRemovedAt: TX.removed, ...over,
});
/** Declined by a guardian with a reason; a refused move recorded in `lifecycle` with `allowed`; a LEGACY non-array `keys.issue`. */
export const declinedOffer = (over = {}) => draftOffer({
  id: 'rof-3', caseId: 'case-2', playerId: 'pl-child1', decisionId: null, status: 'DECLINED', currentRevisionId: 'rofr-5',
  revisions: [revision({ id: 'rofr-5', status: 'DECLINED', internalNote: null, expiresAt: TX.issued + 9 * DAY, issuedAt: TX.issued, issuedBy: BY, respondedAt: TX.accepted, response: { id: 'rofa-2' }, recipientSnapshot: { type: 'guardian', playerId: 'pl-child1', guardianId: 'gd-primary', minor: true, at: TX.issued }, rev: 2, revAt: TX.accepted })],
  responses: [{ id: 'rofa-2', revisionId: 'rofr-5', responseType: 'declined', actorType: 'guardian', actorId: 'gd-primary', actorName: 'Primary Parent', forPlayerId: 'pl-child1', occurredAt: TX.accepted, reason: 'Too far', clientKey: null }],
  keys: { create: null, issue: { key: 'legacy-issue', revisionId: 'rofr-5' }, withdraw: [], revise: [] },
  lifecycle: { applied: false, action: 'considerOffer', reason: 'LIFECYCLE_NOT_ALLOWED', message: 'not from here', allowed: ['offer_accepted', 'withdrawn'], from: 'offer_declined', to: 'offer_declined', at: TX.accepted + MIN },
  history: [ohist('aud-ro6', TX.accepted, 'offer_declined', { revisionId: 'rofr-5', responseId: 'rofa-2', hadReason: true }, { kind: 'guardian', id: 'gd-primary', name: 'Primary Parent' })], updatedAt: TX.accepted + MIN, rev: 3, revAt: TX.accepted + MIN, revBy: REVBY, ...over,
});
/** Withdrawn with a reason; `keys` MISSING entirely and `readReceipts` absent (an older literal); an off-type recipient message; a historically missing current revision (the review's F1 case). */
export const legacyOffer = (over = {}) => { const o = draftOffer({ id: 'rof-4', caseId: 'case-gone', playerId: 'pl-gone-long-ago', decisionId: 'rdec-1', status: 'WITHDRAWN', currentRevisionId: 'rofr-missing', revisions: [revision({ id: 'rofr-6', status: 'WITHDRAWN', recipientMessage: ['not', 'text'], internalNote: null, expiresAt: TX.issued + 9 * DAY, issuedAt: TX.issued, issuedBy: BY, withdrawnAt: TX.revised, withdrawnBy: BY, withdrawReason: 'Budget', recipientSnapshot: { type: 'player', playerId: 'pl-gone-long-ago', guardianId: null, minor: false, at: TX.issued }, rev: 2, revAt: TX.revised, revBy: REVBY })], lifecycle: { applied: true, action: 'considerOffer', from: 'offer_made', to: 'offer_consideration', at: TX.revised }, history: [ohist('aud-ro7', TX.revised, 'offer_withdrawn', { revisionId: 'rofr-6', wasIssued: true, hadReason: true })], updatedAt: TX.revised, rev: 2, revAt: TX.revised, revBy: REVBY, subjectRemovedAt: TX.removed, ...over }); delete o.keys; delete o.readReceipts; return o; };

/** A contact's request (the S8a writer literal for a CONTACT, recruitmentTestFixtures.mjs:22-26 pattern): the pair the respond routes read both ways. */
export const contactRequest = (id, contactId, over = {}) => p4bInvitation({ id, type: 'contact', subject: 'Next season', contactId, trialDetails: null, keys: { invite: { key: `client-${id}`, fp: `fp-${id}` } }, ...over });

/** The standard S8c graph beside the S8a/S8b fixtures: six contacts and four offers. */
export const S8C_FIX = () => ({
  recruitmentContacts: [draftContact(), respondedContact(), nullKeyContact(), externalContact(), legacyContact(), offtypeContact()],
  recruitmentOffers: [draftOffer(), acceptedOffer(), declinedOffer(), legacyOffer()],
});
/** JSON-persisted shape (what the blob held): a live `undefined` is absence. */
export const persisted = (v) => JSON.parse(JSON.stringify(v));
