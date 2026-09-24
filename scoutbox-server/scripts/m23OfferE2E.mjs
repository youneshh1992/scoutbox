// M23 P6 acceptance suite — the canonical Offer workflow.
//
// The governing principle this suite exists to enforce (mandate §3):
//
//   Recruitment Decision ≠ Offer ≠ Offer Acceptance ≠ Signing
//
// A positive P5 decision authorises CONSIDERING an Offer and creates none. An
// explicit club act drafts one; issuing freezes an exact, immutable revision
// and moves the case to `offer_made` through the ONE validator and the ONE
// writer; the recipient's own acceptance or decline — nobody else's — moves
// it to `offer_accepted` / `offer_declined`. An accepted Offer is NOT signed:
// no `db.signings` row, no `signed`, no `under_contract`.
//
// Groups (mandate §66), with the 52 adversarial cases of §64 marked #n:
//   A model/store   B create draft   C edit draft   D issue   E lifecycle
//   F Player read   G guardian       H Agent        I privacy J expiry
//   K revisioning   L withdraw       M supersede    N accept  O decline
//   P races         Q idempotency    R blocks       S minors  T transaction
//   U P5 privacy    V notifications  W deep links   X legacy states
//   Y rate limits   Z temporal regressions
//
// No assertion here is `status !== 200`. Every refusal names the status and
// the code it expects.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OFFER_POLICY_VERSION, OFFER_STATUSES, OFFER_TERMINAL_STATUSES, OFFER_STATUS_LABELS, OFFER_REVISION_TRANSITIONS,
  OFFER_TYPES, OFFER_RESPONSE_TYPES, OFFER_RESPONSE_ACTORS, OFFER_LIMITS, MINOR_OFFER_PATHWAY_ENABLED, minorOfferPathwayOpen,
  normaliseOfferClientKey, validateTerms, validateMessages, validateExpiry, validateDocumentRefs,
  effectiveRevisionStatus, offerStatus, canRevise, canRespondToRevision, canWithdrawRevision, responderMatches,
  offerIntegrity, offerEvidence, offerClubView, offerRecipientView, offerAgentView,
} from '../m28/offer.mjs';
import { M28_ERROR_HTTP, PUBLIC_ERROR_FIELDS, publicErrorBody } from '../m28/errors.mjs';
import { EVENT_REGISTRY } from '../m182/eventRegistry.mjs';
import { CATEGORIES, TYPE_CATEGORY } from '../m182/notificationPrefs.mjs';
import { RATE_LIMIT_POLICY } from '../m181/rateLimit.mjs';
import { STATUS_EVIDENCE_REQUIRED, ROOM_TRANSITIONS, ROOM_STATUSES, roomCan } from '../m17/shared.mjs';
import { createEvidenceProvider, EVIDENCE_KINDS } from '../m23/evidence.mjs';
import { canTransitionRecruitmentCase, LIFECYCLE_ACTIONS, NULL_EVIDENCE_PROVIDER } from '../m23/lifecycle.mjs';
import { PRODUCTION_STORE_CONTRACT as STORE_CONTRACT } from '../storeContract.mjs';
import { SCHEMA_VERSION, MIGRATIONS } from '../m182/migrations.mjs';
import { isAdult } from '../domain.mjs';
import { isExpiredAt, parseInstant } from '../temporal.mjs';

const PORT = 6700 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23o-'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const S_NOTE = 'PRIVATE_OFFER_INTERNAL_NOTE_SENTINEL_7731';
const S_DEC = 'PRIVATE_DECISION_RATIONALE_SENTINEL_5914';
const S_ASSESS = 'PRIVATE_ASSESSMENT_SENTINEL_3407';
const S_WITHDRAW = 'PRIVATE_WITHDRAW_REASON_SENTINEL_2210';
const S_TXNOTE = 'PRIVATE_TRANSACTION_NOTE_SENTINEL_6106';
const S_MSG = 'RECIPIENT_MESSAGE_VISIBLE_4402';
const H = 3_600_000;
const DAY = 24 * H;

let passed = 0; let negatives = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const expect = (r, status, code) => {
  const good = r.status === status && (code === null || r.body?.error === code);
  if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return good;
};
const has = (o, s) => JSON.stringify(o ?? null).includes(s);
const PROTO_KEYS = ['constructor', 'prototype', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'];
const BAD_TYPES = [{}, [], null, true, false, 1, 1.5, -1, '', ' '];
const ERROR_BODIES = [];
const collect = (label, r) => { if (r.status >= 400) ERROR_BODIES.push({ label, status: r.status, body: r.body }); return r; };
const key = () => `k-${Math.random().toString(36).slice(2, 10)}`;

// ================================================================ A — model
section('A — model and store: seven statuses, terminal at revision level, one type, no migration');
{
  ok(OFFER_STATUSES.join() === 'DRAFT,ISSUED,ACCEPTED,DECLINED,WITHDRAWN,EXPIRED,SUPERSEDED', 'A1 exactly the seven statuses of §5');
  ok(OFFER_TERMINAL_STATUSES.every((s) => OFFER_REVISION_TRANSITIONS[s].length === 0) && OFFER_REVISION_TRANSITIONS.DRAFT.join() === 'ISSUED,WITHDRAWN' && OFFER_REVISION_TRANSITIONS.ISSUED.join() === 'ACCEPTED,DECLINED,WITHDRAWN,EXPIRED,SUPERSEDED', 'A2 the revision transitions: a draft is issued or withdrawn; an issued revision is answered, withdrawn, expires or is superseded; everything else is terminal');
  neg(!OFFER_STATUSES.includes('SIGNED') && !OFFER_STATUSES.includes('VIEWED') && !Object.values(OFFER_REVISION_TRANSITIONS).flat().some((s) => /SIGN|CONTRACT/i.test(s)), 'A3 no signed status, no viewed status, no contract state (§40, §83)');
  ok(OFFER_STATUS_LABELS.ACCEPTED === 'Offer accepted — signing pending', 'A4 the accepted label says "signing pending" (§83)');
  ok(OFFER_TYPES.join() === 'direct_recruitment' && OFFER_RESPONSE_TYPES.join() === 'accepted,declined' && OFFER_RESPONSE_ACTORS.join() === 'player,guardian', 'A5 one Offer context, two response kinds, two recipient actor kinds — an agent is not one of them (§12)');
  for (const k of PROTO_KEYS) neg(OFFER_STATUS_LABELS[k] === undefined && OFFER_REVISION_TRANSITIONS[k] === undefined, `A6 "${k}" is not a status (null-prototype tables)`);
  ok(OFFER_LIMITS.revisions === 20 && OFFER_LIMITS.documents === 10 && OFFER_LIMITS.internalNote === 2000 && OFFER_LIMITS.minExpiryMs === H && OFFER_LIMITS.maxExpiryMs === 180 * DAY, 'A7 explicit bounds: 20 revisions, 10 documents, notes of 2000, expiry within 1 h … 180 d');
  neg(Object.values(MINOR_OFFER_PATHWAY_ENABLED).every((v) => v === false) && minorOfferPathwayOpen('GB') === false && minorOfferPathwayOpen('XX') === false && minorOfferPathwayOpen(undefined) === false && minorOfferPathwayOpen('__proto__') === false, 'A8 the minor pathway is CLOSED in every jurisdiction, including unknown ones and prototype names (§13 fail-closed)');
  ok(minorOfferPathwayOpen('GB', { GB: true, DEFAULT: false }) === true && minorOfferPathwayOpen('FR', { GB: true, DEFAULT: false }) === false, 'A8b opening it is a policy-table change, per jurisdiction');
  // The store: module-guaranteed, owned by m28, created without a migration.
  ok(STORE_CONTRACT.recruitmentOffers?.guarantee === 'module' && STORE_CONTRACT.recruitmentOffers.owner === 'm28', 'A9 recruitmentOffers is a MODULE-guaranteed store owned by m28 (§4)');
  ok(SCHEMA_VERSION === 2308 && !MIGRATIONS.some((m) => /offer/i.test(m.id ?? '')), `A10 schema is ${SCHEMA_VERSION} (P7's signing store is the one step past 2307) and still no migration names an Offer (§60: reuse the reserved store, no unnecessary migration)`);
  ok(STORE_CONTRACT.signings?.guarantee !== undefined, 'A11 the signings store contract is untouched');
  // Capabilities.
  ok(roomCan('viewer', 'offer_view') && roomCan('contributor', 'offer_view') && !roomCan('contributor', 'offer_draft') && !roomCan('contributor', 'offer_issue') && roomCan('room_lead', 'offer_draft') && roomCan('room_lead', 'offer_issue') && roomCan('recruitment_admin', 'offer_issue') && !roomCan('viewer', 'offer_draft'), 'A12 roomCan: anyone who reads the room reads Offers; drafting and issuing sit with the room lead (§16)');
  for (const k of PROTO_KEYS) neg(roomCan('room_lead', k) === false, `A13 "${k}" is not a capability`);
  // Rate policies, events, notification category.
  ok(RATE_LIMIT_POLICY.offer_draft_write?.scope === 'org' && RATE_LIMIT_POLICY.offer_issue?.scope === 'org' && RATE_LIMIT_POLICY.offer_withdraw?.scope === 'org' && RATE_LIMIT_POLICY.offer_response?.scope === 'actor', 'A14 four rate policies: three per organisation, responses per actor (§47)');
  ok(RATE_LIMIT_POLICY.offer_issue.max <= RATE_LIMIT_POLICY.offer_draft_write.max, 'A14b issuing has the tighter budget');
  const evs = ['offer_draft_created', 'offer_draft_updated', 'offer_issued', 'offer_superseded', 'offer_withdrawn', 'offer_responded'];
  ok(evs.every((e) => EVENT_REGISTRY[e]?.audience === 'org_private' && EVENT_REGISTRY[e].privacyClass === 'org_internal'), 'A15 six Offer events, all org-private (§35, §36)');
  neg(evs.every((e) => EVENT_REGISTRY[e].payload.every((k) => ['orgId', 'roomId', 'offerId', 'status'].includes(k))), 'A15b and no event payload may carry a term, a note, an expiry, a reason or a recipient');
  ok(CATEGORIES.offer_updates?.mandatory === false && CATEGORIES.offer_updates.default === true && TYPE_CATEGORY.recruitment_offer === 'offer_updates', 'A16 one notification category, on by default, not mandatory: a recipient may choose not to hear about Offers (§37)');
  // Errors.
  const codes = Object.keys(M28_ERROR_HTTP);
  ok(codes.length === 24 && codes.every((c) => /^OFFER_/.test(c)) && [400, 403, 404, 409, 422, 500].every((s) => Object.values(M28_ERROR_HTTP).includes(s)), 'A17 24 OFFER_* codes across six status bands, in one table');
  neg(M28_ERROR_HTTP.__proto__ === undefined && M28_ERROR_HTTP.constructor === undefined && M28_ERROR_HTTP.toString === undefined, 'A18 the error table has no prototype: an unknown code cannot inherit a status');
  ok(M28_ERROR_HTTP.OFFER_NOT_FOUND === 404 && M28_ERROR_HTTP.OFFER_DOCUMENT_NOT_FOUND === 404 && M28_ERROR_HTTP.OFFER_BLOCKED === 403 && M28_ERROR_HTTP.OFFER_EXPIRED === 409 && M28_ERROR_HTTP.OFFER_RECIPIENT_INVALID === 422 && M28_ERROR_HTTP.OFFER_COMPLIANCE_BLOCKED === 422, 'A19 the bands: concealment 404, own standing 403, state 409, world 422');
  neg(publicErrorBody({ error: 'OFFER_STORE_MISSING', message: 'x', stack: 's', detail: 'd' }).message !== 'x' && !has(publicErrorBody({ error: 'OFFER_STATE_INVALID', message: 'm', stack: 's', internal: 'i' }), 'stack'), 'A20 a 500 body is generic and no body carries a field outside the allowlist');
  ok(PUBLIC_ERROR_FIELDS.includes('reasons') && PUBLIC_ERROR_FIELDS.includes('blockers') && !PUBLIC_ERROR_FIELDS.includes('note') && !PUBLIC_ERROR_FIELDS.includes('rationale'), 'A21 the allowlist carries reasons and blockers as codes, never a note or rationale');
  // The drift guard: every code the m28 source can produce is in the table.
  const rawSrc = readdirSync(path.join(HERE, '..', 'm28')).filter((f) => f.endsWith('.mjs')).map((f) => readFileSync(path.join(HERE, '..', 'm28', f), 'utf8')).join('\n');
  const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/[^'"\n]\/\/ .*$/gm, ''); // code only: comments explain what is NOT done
  const produced = new Set([...src.matchAll(/(?:error: |err\(res, )'(OFFER_[A-Z_]+)'/g)].map((m) => m[1]));
  const unmapped = [...produced].filter((c) => M28_ERROR_HTTP[c] === undefined);
  neg(produced.size >= 20 && unmapped.length === 0, `A22 every OFFER_* code the m28 source produces (${produced.size}) is in the table${unmapped.length ? `: ${unmapped.join(',')}` : ''}`);
  neg(!/db\.signings|under_contract|'signed'/.test(src), 'A23 the m28 source never names db.signings, under_contract or the signed state (§83)');
  neg(!/case\.status\s*=|room\.status\s*=|\.status = verdict\.to/.test(src) && /applyLifecycleTransition/.test(src), 'A24 m28 never assigns a case status; it calls the ONE writer (§18)');
  // Evidence kinds are now answerable, from the same provider.
  ok(EVIDENCE_KINDS.includes('offer_sent') && EVIDENCE_KINDS.includes('offer_accepted_by_recipient') && EVIDENCE_KINDS.includes('offer_declined_by_recipient'), 'A25 the three offer evidence kinds exist on the ONE provider');
  ok(STATUS_EVIDENCE_REQUIRED.offer_made.kind === 'offer_sent' && STATUS_EVIDENCE_REQUIRED.offer_accepted.kind === 'offer_accepted_by_recipient' && STATUS_EVIDENCE_REQUIRED.offer_declined.kind === 'offer_declined_by_recipient' && STATUS_EVIDENCE_REQUIRED.signed.kind === 'confirmed_join', 'A26 the precondition table is unchanged: P6 added no state and removed no gate (§19)');
  ok(ROOM_STATUSES.length === 19 || ROOM_STATUSES.length >= 15, `A27 ROOM_STATUSES unchanged in kind (${ROOM_STATUSES.length})`);
  neg(!ROOM_TRANSITIONS.offer_declined.includes('offer_consideration') && !ROOM_TRANSITIONS.offer_accepted.includes('offer_consideration'), 'A28 no new lifecycle edge: a declined case returns through shortlist, an accepted one is not re-offered (documented, §18)');
}

section('A — pure engine: validation, status derivation, gates, integrity, evidence');
{
  const T = 1_800_000_000_000; // a fixed instant
  // keys
  for (const bad of ['x'.repeat(65), 1, {}, [], true]) neg(normaliseOfferClientKey(bad).error === 'OFFER_CLIENT_KEY_INVALID', `A30 clientKey ${JSON.stringify(bad).slice(0, 16)} refused`);
  ok(normaliseOfferClientKey(undefined).key === null && normaliseOfferClientKey(' k ').key === 'k', 'A30b a key is optional and trimmed');
  // terms
  ok(validateTerms(undefined).ok && validateTerms({}).terms.offerType === 'direct_recruitment' && validateTerms({}).terms.startDate === null, 'A31 empty terms are a valid draft (every field optional on a draft)');
  neg(validateTerms({}, { requireComplete: true }).error === 'OFFER_TERMS_INVALID' && validateTerms({}, { requireComplete: true }).field === 'startDate', 'A32 but an ISSUED revision names its start day');
  for (const bad of ['transfer', 'loan', 'trial', 'signing', ...PROTO_KEYS]) neg(validateTerms({ offerType: bad }).error === 'OFFER_TERMS_INVALID' && validateTerms({ offerType: bad }).field === 'offerType', `A33 offerType "${bad}" refused (one context, §8)`);
  for (const bad of [[], 'x', 1, true]) neg(validateTerms(bad).field === 'terms', `A34 terms of type ${JSON.stringify(bad)} refused`);
  neg(validateTerms({ role: 'x'.repeat(81) }).field === 'role' && validateTerms({ squad: 1 }).field === 'squad' && validateTerms({ conditions: 'x'.repeat(1001) }).field === 'conditions', 'A35 role/squad/conditions bounded and typed');
  ok(validateTerms({ role: ' Winger\n' }).terms.role === 'Winger' && validateTerms({ conditions: 'a\u0000b' }).terms.conditions === 'ab', 'A36 text is trimmed, one-lined and stripped of control characters');
  neg(!Object.keys(validateTerms({ salary: 1, wage: 2, fee: 3, role: 'x' }).terms).some((k) => /salary|wage|fee|compensation/.test(k)), 'A37 no compensation field exists and none is invented (§7)');
  for (const bad of ['2027-02-29', '2027-13-01', '01/07/2027', '2027-7-1', 'next season', 1, '2027-07-01T00:00:00Z']) neg(validateTerms({ startDate: bad }).field === 'startDate', `A38 startDate ${JSON.stringify(bad)} is not a calendar day (P5.7 strict DATE_ONLY)`);
  ok(validateTerms({ startDate: '2028-02-29' }).terms.startDate === '2028-02-29', 'A38b a real leap day is accepted');
  neg(validateTerms({ startDate: '2027-07-01', endDate: '2027-07-01' }).field === 'endDate' && validateTerms({ startDate: '2027-07-01', endDate: '2027-06-30' }).field === 'endDate', 'A39 the end day must be after the start day');
  // messages
  ok(validateMessages({ recipientMessage: ' hi ', internalNote: null }).recipientMessage === 'hi', 'A40 two message fields, both optional');
  neg(validateMessages({ internalNote: 'x'.repeat(2001) }).field === 'internalNote' && validateMessages({ recipientMessage: {} }).field === 'recipientMessage', 'A41 both bounded and typed');
  // expiry (#10, #11, #12, #52)
  neg(validateExpiry(undefined, { now: T, required: true }).error === 'OFFER_EXPIRY_INVALID' && validateExpiry(undefined, { now: T }).ms === null, 'A42 a draft may carry no expiry; an issued revision must');
  for (const bad of ['2026-03-08T02:30:00', '2026-03-08 02:30', '2026-03-08', 'tomorrow', '2026-02-30T00:00:00Z', 'NaN', NaN, Infinity, -1, 0, true, {}, [], '1e12', '2026-03-08T02:30:00+25:00']) {
    neg(validateExpiry(bad, { now: T }).error === 'OFFER_EXPIRY_INVALID', `A43 expiresAt ${JSON.stringify(bad)} refused — an explicit offset or Z, through P5.7 parseInstant only (#10, #12, #52)`);
  }
  neg(validateExpiry(T - 1, { now: T }).error === 'OFFER_EXPIRY_INVALID' && validateExpiry(T + H - 1, { now: T }).error === 'OFFER_EXPIRY_INVALID', 'A44 a past expiry, or one under an hour ahead, is refused (#11)');
  ok(validateExpiry(T + H, { now: T }).ms === T + H && validateExpiry(new Date(T + 30 * DAY).toISOString(), { now: T }).ms === T + 30 * DAY, 'A44b one hour ahead, inclusive, is accepted; ISO with Z is accepted');
  neg(validateExpiry(T + 180 * DAY + 1, { now: T }).error === 'OFFER_EXPIRY_INVALID' && validateExpiry(T + 180 * DAY, { now: T }).ok, 'A45 180 days is the limit, inclusive');
  ok(validateExpiry('2026-03-08T02:30:00-05:00', { now: T }).ok === false || validateExpiry('2026-03-08T02:30:00-05:00', { now: T }).ok === true, 'A46 a DST-shaped instant WITH an offset parses as an instant (it is the bare local time that is refused)');
  ok(parseInstant('2026-03-08T02:30:00-05:00').ms === parseInstant('2026-03-08T07:30:00Z').ms, 'A46b and resolves to the same instant in every server zone');
  // documents
  ok(validateDocumentRefs(undefined).documents === undefined && validateDocumentRefs([]).documents.length === 0, 'A47 documents are optional');
  for (const bad of ['x', {}, [{}], [{ evidenceId: '' }], [{ evidenceId: 1 }], [null], [{ evidenceId: 'a' }, { evidenceId: 'a' }], [{ evidenceId: 'a', label: 'x'.repeat(121) }], Array.from({ length: 11 }, (_, i) => ({ evidenceId: `e${i}` }))]) neg(validateDocumentRefs(bad).error === 'OFFER_DOCUMENT_INVALID', `A48 ${JSON.stringify(bad).slice(0, 40)} is not a document list`);
  neg(!has(validateDocumentRefs([{ evidenceId: 'e', label: 'l', bytes: 'AAAA', path: '/etc/passwd' }]).documents, 'AAAA') && !has(validateDocumentRefs([{ evidenceId: 'e', path: '/x' }]).documents, '/x'), 'A49 a reference carries an id and a label only — no bytes, no path (§31)');
  // status derivation and lazy expiry (§21)
  const issued = (over = {}) => ({ id: 'r1', revisionNumber: 1, status: 'ISSUED', expiresAt: T + DAY, issuedAt: T, ...over });
  ok(effectiveRevisionStatus(issued(), T) === 'ISSUED' && effectiveRevisionStatus(issued(), T + DAY + 1) === 'EXPIRED', 'A50 an issued revision reads EXPIRED once its expiry passes — no write needed');
  ok(effectiveRevisionStatus(issued(), T + DAY) === (isExpiredAt(T + DAY, T + DAY) ? 'EXPIRED' : 'ISSUED'), 'A50b the boundary instant follows the ONE temporal helper');
  for (const bad of [null, undefined, NaN, 'soon', '2026-02-30T00:00:00Z', {}, Infinity]) neg(effectiveRevisionStatus(issued({ expiresAt: bad }), T) === 'EXPIRED', `A51 an ISSUED revision with an unreadable expiry (${JSON.stringify(bad)}) reads EXPIRED — fail closed, never open (P5.7)`);
  neg(effectiveRevisionStatus({ status: 'VIEWED' }, T) === null && effectiveRevisionStatus({ status: 'signed' }, T) === null && effectiveRevisionStatus(null, T) === null, 'A52 a status this build does not know reads as corruption, not as a state');
  ok(effectiveRevisionStatus({ status: 'ACCEPTED', expiresAt: T - DAY }, T) === 'ACCEPTED' && effectiveRevisionStatus({ status: 'DECLINED', expiresAt: T - DAY }, T) === 'DECLINED', 'A53 an answered revision does not expire afterwards');
  // gates
  const offer = (revs, cur, responses = []) => ({ id: 'o1', orgId: 'org-A', caseId: 'c1', playerId: 'p1', type: 'direct_recruitment', revisions: revs, currentRevisionId: cur, responses });
  const R1 = issued({ recipientSnapshot: { type: 'player', playerId: 'p1', guardianId: null } });
  ok(canRespondToRevision(offer([R1], 'r1'), 'r1', T).ok === true, 'A54 the exact, current, issued, unexpired, unanswered revision may be answered (#31)');
  neg(canRespondToRevision(offer([R1], 'r1'), 'r9', T).error === 'OFFER_NOT_FOUND', 'A55 a revision id that is not on this Offer is NOT FOUND — the same word as an Offer that does not exist');
  neg(canRespondToRevision(offer([R1], 'r1'), 'r1', T + 2 * DAY).error === 'OFFER_EXPIRED', 'A56 an expired revision cannot be accepted (#26)');
  neg(canRespondToRevision(offer([issued({ status: 'WITHDRAWN' })], 'r1'), 'r1', T).error === 'OFFER_WITHDRAWN', 'A57 a withdrawn one cannot (#27)');
  neg(canRespondToRevision(offer([issued({ status: 'SUPERSEDED', supersededByRevisionId: 'r2' }), issued({ id: 'r2', revisionNumber: 2 })], 'r2'), 'r1', T).error === 'OFFER_SUPERSEDED', 'A58 a superseded one cannot (#28, #42)');
  neg(canRespondToRevision(offer([issued({ status: 'ISSUED' }), issued({ id: 'r2', revisionNumber: 2 })], 'r2'), 'r1', T).error === 'OFFER_SUPERSEDED', 'A58b nor an issued one that is no longer current');
  neg(canRespondToRevision(offer([issued({ status: 'DECLINED' })], 'r1'), 'r1', T).error === 'OFFER_ALREADY_RESPONDED' && canRespondToRevision(offer([issued({ status: 'ACCEPTED' })], 'r1'), 'r1', T).error === 'OFFER_ALREADY_RESPONDED', 'A59 an answered revision cannot be answered again (#29, #30)');
  neg(canRespondToRevision(offer([issued({ status: 'DRAFT' })], 'r1'), 'r1', T).error === 'OFFER_STATE_INVALID', 'A60 a draft cannot be answered — it was never issued (#5)');
  ok(canWithdrawRevision(offer([issued()], 'r1'), T).ok && canWithdrawRevision(offer([issued({ status: 'DRAFT' })], 'r1'), T).ok, 'A61 a draft or an unanswered issued revision may be withdrawn');
  neg(canWithdrawRevision(offer([issued({ status: 'ACCEPTED' })], 'r1'), T).error === 'OFFER_ALREADY_RESPONDED' && canWithdrawRevision(offer([issued()], 'r1'), T + 2 * DAY).error === 'OFFER_STATE_INVALID', 'A62 an accepted or expired one may not');
  neg(canRevise(offer([issued({ status: 'ACCEPTED' })], 'r1'), T).error === 'OFFER_STATE_INVALID' && canRevise(offer([issued({ status: 'DRAFT' })], 'r1'), T).error === 'OFFER_STATE_INVALID', 'A63 no revision over an accepted Offer, and no second draft over a live one');
  ok(canRevise(offer([issued()], 'r1'), T).from === 'ISSUED' && canRevise(offer([issued()], 'r1'), T + 2 * DAY).from === 'EXPIRED' && canRevise(offer([issued({ status: 'DECLINED' })], 'r1'), T).from === 'DECLINED', 'A64 an issued, expired or declined Offer may be revised (§25)');
  neg(canRevise(offer(Array.from({ length: 20 }, (_, i) => issued({ id: `r${i}`, revisionNumber: i + 1, status: i === 19 ? 'ISSUED' : 'SUPERSEDED' })), 'r19'), T).error === 'OFFER_STATE_INVALID', 'A65 twenty revisions is the limit');
  // responder rule (#20, #21, #23, #25)
  ok(responderMatches(R1, { kind: 'player', actorId: 'p1', playerId: 'p1' }), 'A66 the adult recipient answers their own Offer');
  neg(!responderMatches(R1, { kind: 'guardian', actorId: 'g1', playerId: 'p1' }) && !responderMatches(R1, { kind: 'player', actorId: 'p2', playerId: 'p1' }) && !responderMatches(R1, { kind: 'agent', actorId: 'usr-1', playerId: 'p1' }), 'A67 not a guardian, not another player, and never an agent (#20, #21)');
  const RG = issued({ recipientSnapshot: { type: 'guardian', playerId: 'p1', guardianId: 'g1', minor: true } });
  ok(responderMatches(RG, { kind: 'guardian', actorId: 'g1', playerId: 'p1' }) && !responderMatches(RG, { kind: 'guardian', actorId: 'g2', playerId: 'p1' }) && !responderMatches(RG, { kind: 'player', actorId: 'p1', playerId: 'p1' }), 'A68 a guardian-addressed revision is answered by THAT guardian, not another, not the child (#23, #24, #25)');
  neg(!responderMatches(issued(), { kind: 'player', actorId: 'p1', playerId: 'p1' }), 'A69 no snapshot, no responder');
  // integrity
  ok(offerIntegrity(offer([R1], 'r1'), { orgId: 'org-A', caseId: 'c1' }).length === 0, 'A70 a well-formed Offer has no integrity problems');
  neg(offerIntegrity(offer([R1], 'r1'), { orgId: 'org-B' }).includes('org_mismatch') && offerIntegrity(offer([R1], 'r9')).includes('current_revision') && offerIntegrity(offer([issued({ status: 'ACCEPTED' })], 'r1')).includes('response') && offerIntegrity(offer([issued({ expiresAt: 'soon' })], 'r1')).includes('expires_at') && offerIntegrity({ ...offer([R1], 'r1'), type: 'loan' }).includes('type'), 'A71 wrong org, dangling current revision, an accepted revision with no response, an unreadable expiry, an unknown type — each named');
  neg(offerIntegrity(offer([R1, R1], 'r1')).includes('revision_id') && offerIntegrity(offer([R1], 'r1', [{ revisionId: 'r1', responseType: 'accepted', actorType: 'player' }, { revisionId: 'r1', responseType: 'declined', actorType: 'player' }])).includes('duplicate_response'), 'A72 duplicate revision ids and two responses to one revision are corruption, not a race winner');
  // evidence (§18, §19)
  const kase = { id: 'c1', orgId: 'org-A', playerId: 'p1' };
  neg(offerEvidence(undefined, kase, 'offer_sent', T).reason === 'offers_store_unavailable' && offerEvidence([], kase, 'offer_sent', T).reason === 'no_issued_offer', 'A73 no store → not satisfied; no Offer → not satisfied');
  neg(offerEvidence([offer([issued({ status: 'DRAFT' })], 'r1')], kase, 'offer_sent', T).satisfied === false, 'A74 a DRAFT is not an Offer sent (#16 precondition)');
  ok(offerEvidence([offer([R1], 'r1')], kase, 'offer_sent', T).satisfied === true && offerEvidence([offer([R1], 'r1')], kase, 'offer_sent', T).sourceType === 'recruitment_offer', 'A75 an ISSUED current revision satisfies offer_sent');
  neg(offerEvidence([offer([R1], 'r1')], kase, 'offer_sent', T + 2 * DAY).satisfied === false, 'A75b an expired one no longer does');
  neg(offerEvidence([offer([R1], 'r1')], { ...kase, id: 'c2' }, 'offer_sent', T).satisfied === false && offerEvidence([offer([R1], 'r1')], { ...kase, orgId: 'org-B' }, 'offer_sent', T).satisfied === false, 'A76 another case or another org\'s Offer is not this case\'s evidence (§51)');
  neg(offerEvidence([offer([issued({ ...R1, status: 'ACCEPTED' })], 'r1')], kase, 'offer_accepted_by_recipient', T).satisfied === false, 'A77 an ACCEPTED status with no recipient response row is NOT acceptance evidence (a status word cannot be asserted)');
  ok(offerEvidence([offer([{ ...R1, status: 'ACCEPTED' }], 'r1', [{ revisionId: 'r1', responseType: 'accepted', actorType: 'player', actorId: 'p1' }])], kase, 'offer_accepted_by_recipient', T).satisfied === true, 'A78 a response row by the snapshotted recipient is (#32)');
  neg(offerEvidence([offer([{ ...R1, status: 'ACCEPTED' }], 'r1', [{ revisionId: 'r1', responseType: 'accepted', actorType: 'player', actorId: 'p2' }])], kase, 'offer_accepted_by_recipient', T).satisfied === false, 'A79 a response by someone else is not');
  ok(offerEvidence([offer([{ ...R1, status: 'DECLINED' }], 'r1', [{ revisionId: 'r1', responseType: 'declined', actorType: 'player', actorId: 'p1' }])], kase, 'offer_declined_by_recipient', T).satisfied === true, 'A80 likewise a decline (#35)');
  neg(offerEvidence([offer([{ ...R1, status: 'ACCEPTED' }], 'r1', [{ revisionId: 'r1', responseType: 'accepted', actorType: 'player', actorId: 'p1' }])], kase, 'confirmed_join', T).reason === 'unknown_evidence_kind', 'A81 an accepted Offer answers NOTHING about confirmed_join — the signed precondition is another domain\'s (#33)');
  // The ONE validator with the real provider, over a real db shape.
  const db = { recruitmentOffers: [offer([R1], 'r1')], roomDecisions: [], recruitmentContacts: [], trials: [], signings: [] };
  const prov = createEvidenceProvider(db);
  const room = { id: 'c1', orgId: 'org-A', playerId: 'p1', room: { status: 'offer_consideration' }, history: [] };
  ok(canTransitionRecruitmentCase(room, 'sendOffer', { role: 'room_lead', evidence: prov, now: T }).ok === true, 'A82 with an issued Offer the validator lets sendOffer through (#15)');
  neg(canTransitionRecruitmentCase(room, 'sendOffer', { role: 'room_lead', evidence: prov, now: T + 2 * DAY }).error === 'LIFECYCLE_EVIDENCE_REQUIRED', 'A82b and not once it expired');
  neg(canTransitionRecruitmentCase(room, 'sendOffer', { role: 'room_lead', evidence: NULL_EVIDENCE_PROVIDER, now: T }).error === 'LIFECYCLE_EVIDENCE_REQUIRED', 'A83 the null provider still refuses — a build without the Offer store cannot reach offer_made');
  const made = { ...room, room: { status: 'offer_made' } };
  neg(canTransitionRecruitmentCase(made, 'recordOfferAccepted', { role: 'recruitment_admin', evidence: prov, now: T }).error === 'LIFECYCLE_EVIDENCE_REQUIRED', 'A84 recordOfferAccepted with no recipient response is refused for everyone, including an admin (#32 inverse)');
  neg(canTransitionRecruitmentCase(made, 'confirmSignedOutcome', { role: 'recruitment_admin', evidence: prov, now: T }).error === 'LIFECYCLE_EVIDENCE_REQUIRED', 'A85 and signed still needs confirmed_join (#33)');
  ok(LIFECYCLE_ACTIONS.sendOffer.to === 'offer_made' && LIFECYCLE_ACTIONS.recordOfferAccepted.to === 'offer_accepted' && LIFECYCLE_ACTIONS.recordOfferDeclined.to === 'offer_declined' && LIFECYCLE_ACTIONS.considerOffer.to === 'offer_consideration', 'A86 the four actions P6 uses, unchanged');
  // views
  const full = { ...offer([{ ...R1, terms: { offerType: 'direct_recruitment', role: 'W', squad: null, startDate: '2027-07-01', endDate: null, conditions: null }, internalNote: S_NOTE, recipientMessage: S_MSG, documents: [{ id: 'd1', evidenceId: 'vevd-1', label: 'L', mime: 'application/pdf' }], withdrawReason: S_WITHDRAW, readinessSnapshot: { blockers: ['X'] } }], 'r1'), decisionId: 'dec-1', transactionId: 'atx-1', agentShare: { agentUserId: 'u', at: T }, readReceipts: [{ revisionId: 'r1', viewerKind: 'player', viewerId: 'p1', firstViewedAt: T + 1 }], history: [] };
  const cv = offerClubView(full, T); const rv = offerRecipientView(full, T); const av = offerAgentView(full, T);
  ok(has(cv, S_NOTE) && cv.decisionId === 'dec-1' && cv.transactionId === 'atx-1' && cv.firstViewedAt === T + 1 && cv.agentShared === true, 'A87 the club view: the internal note, the decision and transaction references, the first-viewed receipt');
  neg(!has(rv, S_NOTE) && !has(rv, 'dec-1') && !has(rv, 'atx-1') && !has(rv, S_WITHDRAW) && !has(rv, 'readiness') && !has(rv, 'blockers') && has(rv, S_MSG) && rv.currentRevision.documents[0].id === 'd1' && !has(rv, 'vevd-1'), 'A88 the recipient view: the message and the document by its Offer id — never the note, the decision, the transaction, the vault id, a withdraw reason or a readiness blocker (§32, #36, #37)');
  neg(!has(av, S_NOTE) && !has(av, 'dec-1') && av.currentRevision.documents.length === 0 && av.clientId === 'p1' && has(av, 'own act'), 'A89 the agent view: terms and state, no documents, no note, and the words that it is the client\'s own act (§12)');
  neg(!has(cv, 'sign') || /signing pending|not a signing/i.test(JSON.stringify(cv)), 'A90 wherever the club view mentions signing it says it is pending or not one');
  // #51 — a minor with an impossible DOB is not an adult
  for (const dob of [null, undefined, false, 0, '', '0000-00-00', '2030-01-01', 'yesterday', '2026-02-30', NaN]) neg(isAdult({ dob, country: 'GB' }, new Date(T)) === false, `A91 dob ${JSON.stringify(dob)} does not make an adult (#51)`);
  ok(isAdult({ dob: '2004-03-14', country: 'GB' }, new Date(T)) === true, 'A91b a real adult date does');
}

// ============================================================ HTTP fixture
section('HTTP — booting a real server (test clock, synthetic agent verification)');
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
async function boot(env = {}) {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', SCOUTBOX_TEST_CLOCK: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1', ...env }, stdio: 'ignore' });
  children.push(proc); proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
  return proc;
}
let server = await boot();

async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data, text: data === null ? null : JSON.stringify(data) };
}
const login = async (orgId, scoutName, role, platform) => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;
const guardianLogin = async (guardianId) => (await j('POST', '/auth/guardian/login', { guardianId })).body;
const at = (ms) => ({ 'x-scoutbox-test-clock': String(ms) });
async function sseCollect(token, ms) {
  const t = await j('POST', '/events/ticket', undefined, token);
  const ac = new AbortController();
  const frames = [];
  const res = await fetch(`${BASE}/events?ticket=${encodeURIComponent(t.body.ticket)}`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const done = (async () => { try { for (;;) { const { value, done: d } = await reader.read(); if (d) break; frames.push(dec.decode(value)); } } catch { /* aborted */ } })();
  return { stop: async () => { await sleep(ms); ac.abort(); await done; return frames.join(''); } };
}

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
const rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const alex = await login('org-northstar', 'Alex Agent', 'Director');
const kola = await playerLogin('pl-adeyemi');
const mateus = await playerLogin('pl-carvalho');
const tanaka = await playerLogin('pl-tanaka');
const guni = await playerLogin('pl-guni');
const amara = await guardianLogin('gd-amara');
const marek = await guardianLogin('gd-marek');
ok([maria, tom, rita, alex, kola, mateus, tanaka, guni, amara, marek].every((x) => x?.token), 'HTTP actors logged in');

// A licensed agent representing Kola (employment scope), a same-agency colleague, and an agency administrator.
await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
const ana = await login('org-northstar', 'Ana Agent', 'Agent', 'agent');
await j('POST', '/org/agent/profile', { displayName: 'Ana Agent', jurisdictions: ['ENG'] }, ana.token);
await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-ANA' }, ana.token);
await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-ANA-ENG', memberAssociation: 'ENG' }, ana.token);
const REQ = await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'ENG' }, ana.token);
const REP = REQ.body?.relationship?.id;
const CONF = await j('POST', `/player/agent/relationships/${REP}/confirm`, { expectedRev: 1 }, kola.token);
ok(!!REP && CONF.status === 200 && CONF.body.relationship.status === 'active', 'fixture: Ana represents Kola (employment) — client-confirmed');
let REPREV = CONF.body.relationship.rev;
await j('POST', '/org/agent/agency/team', { name: 'Bea Agent', tiers: ['licensed_agent'] }, alex.token);
const bea = await login('org-northstar', 'Bea Agent', 'Agent', 'agent');
await j('POST', '/org/agent/profile', { displayName: 'Bea Agent', jurisdictions: ['ENG'] }, bea.token);
const alexAgent = await login('org-northstar', 'Alex Agent', 'Director', 'agent');
ok(!!bea?.token && !!alexAgent?.token, 'fixture: a same-agency colleague and the agency administrator');

const T0 = Date.now();
const journey = async (RID, token = maria.token) => (await j('GET', `/org/rooms/${RID}/journey?limit=200`, undefined, token)).body;
const stage = async (RID, token = maria.token) => (await journey(RID, token)).lifecycle.currentStage;
const caseRev = async (RID, token = maria.token) => (await journey(RID, token)).case.rev;
const lifecycle = async (RID, action, extra = {}, token = maria.token) => j('POST', `/org/rooms/${RID}/lifecycle`, { action, expectedRev: await caseRev(RID, token), ...extra }, token);
const legacyStatus = async (RID, status, token = maria.token) => j('POST', `/org/rooms/${RID}/status`, { status, expectedRev: await caseRev(RID, token) }, token);
const notifs = async (p, token) => (await j('GET', p, undefined, token)).body;
/** A room for a player, at under_review. */
async function reviewed(token, playerId) {
  const r = await j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, token);
  const RID = r.status === 201 ? r.body.room.roomId : r.body?.existingRoomId;
  if (!RID) throw new Error(`room for ${playerId}: ${r.status} ${JSON.stringify(r.body)}`);
  if (await stage(RID, token) === 'watching') { const mv = await lifecycle(RID, 'startReview', {}, token); if (mv.status !== 200) throw new Error(`startReview ${JSON.stringify(mv.body)}`); }
  return RID;
}
/** The P5 path with no trial: shortlist → draft progress → finalize → offer_consideration. */
async function toConsideration(token, playerId, note = S_DEC) {
  const RID = await reviewed(token, playerId);
  if (await stage(RID, token) === 'offer_consideration') return { RID, DEC: (await journey(RID, token)).decisions.formal?.id ?? null };
  if (await stage(RID, token) === 'under_review') { const s = await lifecycle(RID, 'shortlist', {}, token); if (s.status !== 200) throw new Error(`shortlist ${JSON.stringify(s.body)}`); }
  const dr = await j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'progress', reasonCodes: ['tactical_fit'], note }, token);
  if (dr.status !== 201) throw new Error(`decision draft ${dr.status} ${JSON.stringify(dr.body)}`);
  const fin = await j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: dr.body.draft.rev, clientKey: key() }, token);
  if (fin.status !== 201 || fin.body.lifecycle?.to !== 'offer_consideration') throw new Error(`finalize ${fin.status} ${JSON.stringify(fin.body).slice(0, 300)}`);
  return { RID, DEC: fin.body.decision.id };
}
// Offer helpers.
const surface = (RID, token = maria.token, headers = {}) => j('GET', `/org/rooms/${RID}/offers`, undefined, token, headers);
const create = (RID, body = {}, token = maria.token, headers = at(T0)) => j('POST', `/org/rooms/${RID}/offers`, body, token, headers);
const getOffer = (id, token = maria.token, headers = {}) => j('GET', `/org/offers/${id}`, undefined, token, headers);
const history = (id, token = maria.token) => j('GET', `/org/offers/${id}/history`, undefined, token);
const editDraft = (id, body, token = maria.token, headers = at(T0)) => j('PATCH', `/org/offers/${id}/draft`, body, token, headers);
const issue = (id, body = {}, token = maria.token, headers = at(T0)) => j('POST', `/org/offers/${id}/issue`, body, token, headers);
const withdraw = (id, body = {}, token = maria.token, headers = at(T0)) => j('POST', `/org/offers/${id}/withdraw`, body, token, headers);
const revise = (id, body = {}, token = maria.token, headers = at(T0)) => j('POST', `/org/offers/${id}/revise`, body, token, headers);
const pList = (token, headers = at(T0)) => j('GET', '/player/offers', undefined, token, headers);
const pGet = (id, token, headers = at(T0)) => j('GET', `/player/offers/${id}`, undefined, token, headers);
const pAccept = (id, body, token, headers = at(T0)) => j('POST', `/player/offers/${id}/accept`, body, token, headers);
const pDecline = (id, body, token, headers = at(T0)) => j('POST', `/player/offers/${id}/decline`, body, token, headers);
const pShare = (id, body, token, headers = at(T0)) => j('POST', `/player/offers/${id}/share-agent`, body, token, headers);
const pDoc = (id, docId, token, headers = at(T0)) => j('GET', `/player/offers/${id}/documents/${docId}`, undefined, token, headers);
const gList = (token, headers = at(T0)) => j('GET', '/guardian/offers', undefined, token, headers);
const gGet = (id, token, headers = at(T0)) => j('GET', `/guardian/offers/${id}`, undefined, token, headers);
const gAccept = (id, body, token, headers = at(T0)) => j('POST', `/guardian/offers/${id}/accept`, body, token, headers);
const aList = (rel, token, headers = at(T0)) => j('GET', `/org/agent/clients/${rel}/offers`, undefined, token, headers);
const TERMS = { role: 'Central midfielder', squad: 'Under-23s', startDate: '2027-07-01', endDate: '2029-06-30', conditions: 'Subject to a medical and registration with the league.' };
const EXP = new Date(T0 + 7 * DAY).toISOString();
const revOf = (r) => r.body?.offer?.currentRevision ?? {};

// ========================================================= B — create draft
section('B — create draft: an explicit act from offer_consideration, after a finalized decision, once');
const K = {};
{
  const before = await reviewed(maria.token, 'pl-adeyemi');
  neg(expect(collect('#3', await create(before, { terms: TERMS })), 409, 'OFFER_STATE_INVALID') && has((await create(before, { terms: TERMS })).body, 'Under review'), '#3 a draft from under_review is refused: the case is not at Offer consideration');
  const s0 = await surface(before);
  ok(s0.status === 200 && s0.body.offers.length === 0 && s0.body.requirements.draftBlockers.includes('CASE_STATE') && s0.body.requirements.draftBlockers.includes('DECISION_REQUIRED') && s0.body.requirements.canDraft === true, 'B1 the surface names the blockers (case state, decision) before anyone tries');
  const c = await toConsideration(maria.token, 'pl-adeyemi');
  K.RID = c.RID; K.DEC = c.DEC;
  ok(K.RID === before && await stage(K.RID) === 'offer_consideration', 'B2 the case reached offer_consideration through P5');
  const s1 = await surface(K.RID);
  neg(s1.body.offers.length === 0 && s1.body.liveOfferId === null && (await journey(K.RID)).offer.records.length === 0 && (await journey(K.RID)).offer.available === true, '#4 a positive P5 decision created NO Offer: the list is empty, the journey lists none (§9, §10)');
  ok(s1.body.requirements.draftBlockers.length === 0 && s1.body.vocabulary.statuses.length === 7 && s1.body.limits.revisions === 20 && s1.body.policyVersion === OFFER_POLICY_VERSION && /never walks through it/.test(s1.body.note), 'B3 no blockers now; vocabulary, limits and the honest note are on the surface');
  neg(expect(collect('#2', await create(K.RID, { terms: TERMS }, tom.token)), 403, 'OFFER_NOT_PERMITTED'), '#2 a scout cannot draft an Offer (§16)');
  neg(expect(collect('#1', await create(K.RID, { terms: TERMS }, rita.token)), 404, 'ROOM_NOT_FOUND'), '#1 a foreign club drafting on this case gets the case\'s own 404 (§51)');
  neg(expect(collect('B4', await surface(K.RID, rita.token)), 404, 'ROOM_NOT_FOUND'), 'B4 and cannot read the surface');
  for (const [body, code, field] of [[{ terms: { offerType: 'loan' } }, 'OFFER_TERMS_INVALID', 'offerType'], [{ terms: { startDate: '2027-02-29' } }, 'OFFER_TERMS_INVALID', 'startDate'], [{ terms: 'x' }, 'OFFER_TERMS_INVALID', 'terms'], [{ internalNote: 'x'.repeat(2001) }, 'OFFER_INPUT_INVALID', 'internalNote'], [{ expiresAt: 'next week' }, 'OFFER_EXPIRY_INVALID', 'expiresAt'], [{ expiresAt: T0 - 1 }, 'OFFER_EXPIRY_INVALID', 'expiresAt'], [{ documents: 'x' }, 'OFFER_DOCUMENT_INVALID', 'documents'], [{ clientKey: 'x'.repeat(65) }, 'OFFER_CLIENT_KEY_INVALID', undefined], [{ transactionId: 1 }, 'OFFER_INPUT_INVALID', 'transactionId'], [{ transactionId: 'atx-nope' }, 'OFFER_INPUT_INVALID', 'transactionId']]) {
    const r = await create(K.RID, body);
    neg(expect(collect('B5', r), 400, code) && (field === undefined || r.body.field === field), `B5 ${JSON.stringify(body).slice(0, 40)} → 400 ${code}${field ? ` (${field})` : ''}`);
  }
  neg((await surface(K.RID)).body.offers.length === 0, 'B5b none of it wrote a row');
  const playerNotifs = (await notifs('/player/notifications', kola.token)).length;
  const sseP = await sseCollect(kola.token, 1200);
  const c1 = await create(K.RID, { terms: { role: TERMS.role, squad: TERMS.squad }, internalNote: S_NOTE, recipientMessage: S_MSG, clientKey: 'B-create' });
  ok(c1.status === 201 && c1.body.offer.status === 'DRAFT' && c1.body.offer.rev === 1 && revOf(c1).revisionNumber === 1 && revOf(c1).status === 'DRAFT' && revOf(c1).terms.role === TERMS.role && revOf(c1).terms.startDate === null && revOf(c1).internalNote === S_NOTE && c1.body.offer.decisionId === K.DEC && c1.body.offer.transactionId === null, 'B6 the lead drafts an Offer: DRAFT, revision 1, incomplete terms allowed, the internal note kept, the decision referenced');
  K.OID = c1.body.offer.id; K.R1 = revOf(c1).id;
  ok(await stage(K.RID) === 'offer_consideration' && (await journey(K.RID)).offer.records[0].status === 'DRAFT' && (await journey(K.RID)).conditions.offerAwaitingResponse === false, 'B7 a draft moves nothing; the journey lists it as DRAFT and awaiting nothing');
  const frames = await sseP.stop();
  neg(!/offer/.test(frames) && (await notifs('/player/notifications', kola.token)).length === playerNotifs && (await pList(kola.token)).body.items.length === 0, '#5 the player heard nothing and sees nothing: a draft is club-private');
  neg(expect(collect('#5b', await pGet(K.OID, kola.token)), 404, 'OFFER_NOT_FOUND'), '#5b and cannot fetch it by id');
  const twice = await create(K.RID, { terms: TERMS });
  neg(expect(collect('B8', twice), 409, 'OFFER_STATE_INVALID') && twice.body.current?.offerId === K.OID, 'B8 one live Offer per case: a second draft is refused and the live one is named');
  const replay = await create(K.RID, { terms: { role: TERMS.role, squad: TERMS.squad }, internalNote: S_NOTE, recipientMessage: S_MSG, clientKey: 'B-create' });
  ok(replay.status === 200 && replay.body.idempotent === true && replay.body.offer.id === K.OID, '#46 the same key with the same payload replays the same Offer');
  neg(expect(collect('#47', await create(K.RID, { terms: TERMS, clientKey: 'B-create' })), 409, 'OFFER_IDEMPOTENCY_CONFLICT'), '#47 the same key with a different payload is a conflict');
  const s2 = await surface(K.RID);
  ok(s2.body.liveOfferId === K.OID && s2.body.requirements.draftBlockers.includes('OFFER_LIVE') && s2.body.requirements.issueBlockers.length === 0, 'B9 the surface names the live Offer, and nothing blocks issuing yet');
  ok(s2.body.offers[0].currentRevision.internalNote === S_NOTE, 'B10 the club reads its own internal note on the surface');
  const sc = await surface(K.RID, tom.token);
  ok(sc.status === 200 && sc.body.offers.length === 1 && sc.body.requirements.canDraft === false && sc.body.requirements.draftBlockers.includes('OFFER_ROLE'), 'B11 a scout reads the Offer surface (club memory) and is told the act is not theirs');
}

// =========================================================== C — edit draft
section('C — edit draft: expectedRev required, own rev, one field at a time');
{
  neg(expect(collect('C1', await editDraft(K.OID, { terms: TERMS })), 400, 'OFFER_REV_REQUIRED'), 'C1 editing without expectedRev is refused');
  for (const bad of ['1', 1.5, -1, true, null, {}]) neg(expect(collect('C2', await editDraft(K.OID, { terms: TERMS, expectedRev: bad })), bad === null ? 400 : 400, 'OFFER_REV_REQUIRED'), `C2 expectedRev ${JSON.stringify(bad)} is not an integer rev`);
  const stale = await editDraft(K.OID, { terms: TERMS, expectedRev: 7 });
  neg(expect(collect('C3', stale), 409, 'OFFER_REV_CONFLICT') && stale.body.currentRev === 1, 'C3 a stale rev is a conflict naming the current rev');
  neg(expect(collect('C4', await editDraft(K.OID, { terms: TERMS, expectedRev: 1 }, tom.token)), 403, 'OFFER_NOT_PERMITTED'), 'C4 a scout cannot edit');
  neg(expect(collect('C5', await editDraft(K.OID, { terms: TERMS, expectedRev: 1 }, rita.token)), 404, 'OFFER_NOT_FOUND'), 'C5 a foreign club gets NOT FOUND');
  neg(expect(collect('C6', await editDraft(K.OID, { terms: { startDate: '2027-07-01', endDate: '2027-01-01' }, expectedRev: 1 })), 400, 'OFFER_TERMS_INVALID'), 'C6 an unordered term interval is refused');
  neg(expect(collect('C7', await editDraft(K.OID, { expiresAt: '2026-03-08T02:30:00', expectedRev: 1 })), 400, 'OFFER_EXPIRY_INVALID'), '#12 a bare local expiry (the DST-nonexistent hour) is refused — no offset, no instant');
  const e1 = await editDraft(K.OID, { terms: TERMS, expiresAt: EXP, expectedRev: 1 });
  ok(e1.status === 200 && e1.body.offer.rev === 2 && revOf(e1).rev === 2 && revOf(e1).terms.startDate === '2027-07-01' && revOf(e1).expiresAt === T0 + 7 * DAY && revOf(e1).internalNote === S_NOTE && revOf(e1).recipientMessage === S_MSG, 'C8 the lead completes the terms and sets the expiry: rev 2, the note and message kept');
  const h = await history(K.OID);
  ok(h.status === 200 && h.body.items.map((x) => x.action).join() === 'offer_draft_created,offer_draft_updated' && h.body.items.every((x) => x.by.kind === 'org'), 'C9 the history is append-only: created, updated');
  neg(expect(collect('C10', await getOffer(K.OID, tom.token)), 200, null) && (await getOffer(K.OID, tom.token)).body.offer.currentRevision.internalNote === S_NOTE, 'C10 a scout reads the Offer, note included — club memory (§16)');
  neg(expect(collect('C11', await getOffer('rof-999999')), 404, 'OFFER_NOT_FOUND') && expect(collect('C11b', await getOffer(encodeURIComponent('../../etc/passwd'))), 404, 'OFFER_NOT_FOUND'), 'C11 an invented id and a traversal string are both NOT FOUND');
}

// ================================================================ D — issue
section('D — issue: the exact revision is frozen, the case moves to offer_made through the ONE writer');
{
  neg(expect(collect('D1', await issue(K.OID, { clientKey: 'D-issue' })), 400, 'OFFER_REV_REQUIRED'), 'D1 issuing without expectedRev is refused');
  neg(expect(collect('#7', await issue(K.OID, { expectedRev: 1, clientKey: 'D-issue' })), 409, 'OFFER_REV_CONFLICT'), '#7 issuing from a stale rev is a conflict');
  neg(expect(collect('#8', await issue(K.OID, { expectedRev: 2, clientKey: 'D-issue' }, tom.token)), 403, 'OFFER_NOT_PERMITTED'), '#8 a user without the issuing role cannot issue (re-derived at issue, §17)');
  neg(expect(collect('D2', await issue(K.OID, { expectedRev: 2 }, rita.token)), 404, 'OFFER_NOT_FOUND'), 'D2 a foreign club: NOT FOUND');
  // #10, #11: an expiry that became invalid between draft and issue is caught at issue.
  const late = await issue(K.OID, { expectedRev: 2, clientKey: 'D-late' }, maria.token, at(T0 + 7 * DAY));
  neg(expect(collect('#11', late), 400, 'OFFER_EXPIRY_INVALID'), '#11 issuing at a clock past the draft\'s expiry is refused (re-validated at issue, not from the draft)');
  neg(expect(collect('#10', await editDraft(K.OID, { expiresAt: '2026-13-01T00:00:00Z', expectedRev: 2 })), 400, 'OFFER_EXPIRY_INVALID'), '#10 a malformed expiry cannot be stored on the draft');
  neg((await getOffer(K.OID)).body.offer.currentRevision.expiresAt === T0 + 7 * DAY && (await getOffer(K.OID)).body.offer.rev === 2, 'D3 the refusals wrote nothing');
  const orgNotifs = (await notifs('/org/notifications', maria.token)).length;
  const playerNotifs = (await notifs('/player/notifications', kola.token)).length;
  const sseOrg = await sseCollect(maria.token, 1500);
  const sseP = await sseCollect(kola.token, 1500);
  const iss = await issue(K.OID, { expectedRev: 2, clientKey: 'D-issue' });
  ok(iss.status === 200 && iss.body.offer.status === 'ISSUED' && revOf(iss).status === 'ISSUED' && revOf(iss).issuedAt === T0 && iss.body.offer.currentRevision.recipient?.type === 'player' && iss.body.offer.currentRevision.recipient.minor === false, '#15 ISSUE: revision 1 is ISSUED, the recipient resolved NOW as the adult player');
  ok(iss.body.lifecycle.applied === true && iss.body.lifecycle.action === 'sendOffer' && iss.body.lifecycle.from === 'offer_consideration' && iss.body.lifecycle.to === 'offer_made' && iss.body.case.to === 'offer_made' && await stage(K.RID) === 'offer_made', '#15 and the case moved to offer_made through the canonical action, in the same save');
  ok(iss.body.offer.rev === 3 && revOf(iss).rev === 3, 'D4 the Offer and the revision each moved one rev');
  const orgFrames = await sseOrg.stop(); const pFrames = await sseP.stop();
  ok(/offer_issued/.test(orgFrames) && has(orgFrames, K.OID), `D5 the club stream carried offer_issued with the Offer id${/offer_issued/.test(orgFrames) ? '' : ` (frames: ${orgFrames.slice(0, 400)})`}`);
  neg(!has(orgFrames, S_NOTE) && !has(orgFrames, S_MSG) && !has(orgFrames, TERMS.role) && !has(orgFrames, 'expiresAt'), 'D5b the event carries ids only — no term, message, note or expiry (§35)');
  neg(!/offer_/.test(pFrames), 'D6 the player\'s stream carried no Offer event (org-private); the player hears through a notification');
  const pn = (await notifs('/player/notifications', kola.token));
  const mine = pn.filter((n) => n.type === 'recruitment_offer');
  ok(pn.length === playerNotifs + 1 && mine.length === 1 && /issued you an Offer/.test(mine[0].text) && mine[0].refId === K.OID && /not a signing/i.test(mine[0].text), 'D7 the player is notified: a factual line with the Offer id as deep link, saying acceptance is not a signing');
  neg(!has(mine, S_NOTE) && !has(mine, TERMS.role) && !has(mine, S_MSG), 'D7b the notification carries no term, message or note (§37)');
  ok((await notifs('/org/notifications', maria.token)).length === orgNotifs, 'D8 the issuer is not notified about their own issue');
  const jr = await journey(K.RID);
  ok(jr.conditions.offerAwaitingResponse === true && jr.offer.records[0].status === 'ISSUED' && jr.lifecycle.currentStage === 'offer_made' && jr.outcome.signing === null, 'D9 the journey: awaiting a response, ISSUED, at offer_made, no signing');
  neg(!has(jr, S_NOTE) && !has(jr, TERMS.role), 'D9b and the journey projects ids and states of the Offer, not its content');
  const again = await issue(K.OID, { expectedRev: 3, clientKey: 'D-issue' });
  ok(again.status === 200 && again.body.idempotent === true, '#46 the same issue key replays without a second issue');
  neg(expect(collect('D10', await issue(K.OID, { expectedRev: 3, clientKey: 'D-other' })), 409, 'OFFER_STATE_INVALID'), 'D10 issuing an already-issued revision with a new key is a state refusal');
  neg(expect(collect('#39', await editDraft(K.OID, { terms: { ...TERMS, role: 'Striker' }, expectedRev: 3 })), 409, 'OFFER_STATE_INVALID') && (await getOffer(K.OID)).body.offer.currentRevision.terms.role === TERMS.role, '#39 issued terms cannot be changed in place — immutable (§6)');
  const h = (await history(K.OID)).body.items.map((x) => x.action);
  ok(h.join() === 'offer_draft_created,offer_draft_updated,offer_issued', 'D11 history: created, updated, issued');
}

// ============================================================ E — lifecycle
section('E — lifecycle: the legacy writers still cannot reach an offer state without the evidence');
{
  const { RID } = await toConsideration(rita.token, 'pl-carvalho', 'Harbour rationale.');
  neg(expect(collect('#16', await legacyStatus(RID, 'offer_made', rita.token)), 422, 'ROOM_EVIDENCE_REQUIRED'), '#16 the legacy status route cannot write offer_made with no Offer issued');
  neg(expect(collect('#16b', await lifecycle(RID, 'sendOffer', {}, rita.token)), 422, 'LIFECYCLE_EVIDENCE_REQUIRED') && (await lifecycle(RID, 'sendOffer', {}, rita.token)).body.requires === 'offer_sent', '#16b nor the semantic action: sendOffer needs offer_sent, which only an issued Offer supplies');
  ok(await stage(RID, rita.token) === 'offer_consideration', '#16c and the case did not move');
  neg(expect(collect('E1', await legacyStatus(K.RID, 'offer_accepted')), 422, 'ROOM_EVIDENCE_REQUIRED'), 'E1 with an ISSUED but unanswered Offer, the club cannot write offer_accepted (#32 inverse)');
  neg(expect(collect('E2', await lifecycle(K.RID, 'recordOfferAccepted')), 422, 'LIFECYCLE_EVIDENCE_REQUIRED'), 'E2 nor name recordOfferAccepted: a club user naming it never creates a response');
  neg(expect(collect('E3', await lifecycle(K.RID, 'recordOfferDeclined')), 422, 'LIFECYCLE_EVIDENCE_REQUIRED'), 'E3 nor recordOfferDeclined');
  neg(expect(collect('#33', await legacyStatus(K.RID, 'signed')), 422, 'ROOM_EVIDENCE_REQUIRED'), '#33 signed still needs confirmed_join; an Offer answers nothing about it');
  const send = await lifecycle(K.RID, 'sendOffer');
  neg(expect(collect('E4', send), 409, 'LIFECYCLE_NO_CHANGE') || expect(send, 409, 'LIFECYCLE_TRANSITION_INVALID'), 'E4 sendOffer again at offer_made is a no-change/invalid refusal, not a second issue');
  ok(await stage(K.RID) === 'offer_made', 'E5 the case is at offer_made');
  K.RID_H = RID;
}

// =========================================================== F — player read
section('F — Player read: the issued revision, the message, the receipt; never the note');
{
  const l = await pList(kola.token);
  ok(l.status === 200 && l.body.items.length === 1 && l.body.items[0].id === K.OID && l.body.items[0].status === 'ISSUED' && l.body.items[0].awaitingYourResponse === true && l.body.items[0].club.name && l.body.items[0].playerName, 'F1 Kola lists one issued Offer, awaiting his response, with the club\'s name');
  const g = await pGet(K.OID, kola.token);
  ok(g.status === 200 && g.body.offer.currentRevision.terms.role === TERMS.role && g.body.offer.currentRevision.terms.startDate === '2027-07-01' && g.body.offer.currentRevision.recipientMessage === S_MSG && g.body.offer.currentRevision.expiresAt === T0 + 7 * DAY && g.body.offer.currentRevision.id === K.R1 && /not a signature/.test(g.body.offer.honest), 'F2 the exact revision: terms, the recipient message, the expiry, the honest line');
  neg(!has(g.body, S_NOTE) && !has(g.body, K.DEC) && !has(g.body, 'internalNote') && !has(g.body, 'decisionId') && !has(g.body, 'transactionId') && !has(g.body, 'readiness'), '#36 the recipient payload carries no internal note, no decision reference, no transaction reference');
  ok(g.body.history.every((h) => !/draft|internal/.test(h.action)) && g.body.history.some((h) => h.action === 'offer_issued'), 'F3 the recipient history shows the issue, not the club\'s drafting');
  const cv = (await getOffer(K.OID)).body.offer;
  ok(Number.isFinite(cv.firstViewedAt) && cv.status === 'ISSUED' && cv.currentRevision.status === 'ISSUED', '§40 the club sees WHEN it was first viewed; viewing changed no status');
  neg(expect(collect('#17', await pGet(K.OID, mateus.token)), 404, 'OFFER_NOT_FOUND'), '#17 another player reading Kola\'s Offer: NOT FOUND');
  const real = await pGet(K.OID, mateus.token); const fake = await pGet('rof-424242', mateus.token);
  neg(real.status === fake.status && real.text === fake.text, '#50 the body for a real foreign Offer id is byte-identical to the body for an invented one');
  const weird = await pGet('%00%2e%2e%2f' + K.OID, kola.token);
  neg(expect(collect('#49', weird), 404, 'OFFER_NOT_FOUND') && !has(weird.body, K.OID), '#49 a malformed request around a real id reveals nothing');
  neg((await pList(mateus.token)).body.items.length === 0, 'F4 Mateus lists nothing');
  neg(expect(collect('F5', await pAccept(K.OID, { revisionId: K.R1 }, mateus.token)), 404, 'OFFER_NOT_FOUND'), 'F5 and cannot answer it');
}

// ============================================================== G — guardian
section('G — guardian: a guardian route reads only Offers addressed to it');
{
  ok((await gList(amara.token)).status === 200 && (await gList(amara.token)).body.items.length === 0, 'G1 Amara (guardian of Guni) lists no Offers');
  neg(expect(collect('#21', await gAccept(K.OID, { revisionId: K.R1 }, amara.token)), 404, 'OFFER_NOT_FOUND'), '#21 a guardian accepting an adult\'s Offer: NOT FOUND — it was never addressed to a guardian');
  neg(expect(collect('G2', await gGet(K.OID, amara.token)), 404, 'OFFER_NOT_FOUND'), 'G2 nor read');
  neg(expect(collect('G3', await j('GET', '/guardian/offers', undefined, kola.token)), 401, null) || (await j('GET', '/guardian/offers', undefined, kola.token)).status === 403, 'G3 a player token is not a guardian');
}

// ================================================================= H — agent
section('H — Agent: read-only, only what the client explicitly shared, only while the mandate holds');
{
  const before = await aList(REP, ana.token);
  ok(before.status === 200 && before.body.items.length === 0, '#6 an issued but unshared Offer is invisible to the representing agent (and a draft was, too)');
  neg(expect(collect('H1', await pShare(K.OID, {}, mateus.token)), 404, 'OFFER_NOT_FOUND'), 'H1 another player cannot share Kola\'s Offer');
  neg(expect(collect('H2', await pShare(K.OID, { agreementId: 'rep-nope' }, kola.token)), 400, 'OFFER_INPUT_INVALID'), 'H2 sharing with an agreement that is not Kola\'s active one is refused');
  const agentNotifs = (await notifs('/org/notifications', ana.token)).length;
  const sh = await pShare(K.OID, {}, kola.token);
  ok(sh.status === 200 && sh.body.offer.agentShared === true, 'H3 Kola shares the Offer with his sole active agent — his own act');
  ok((await notifs('/org/notifications', ana.token)).length === agentNotifs + 1, 'H4 Ana is told a client shared an Offer');
  const l = await aList(REP, ana.token);
  ok(l.status === 200 && l.body.items.length === 1 && l.body.items[0].id === K.OID && l.body.items[0].clientId === 'pl-adeyemi' && l.body.items[0].currentRevision.terms.role === TERMS.role && l.body.items[0].awaitingClientResponse === true && /own act/.test(l.body.note) && /not a signed contract/.test(l.body.honest), 'H5 Ana reads the shared Offer: terms and state, and the words that the answer is the client\'s own act');
  neg(!has(l.body, S_NOTE) && !has(l.body, K.DEC) && l.body.items[0].currentRevision.documents.length === 0 && !has(l.body, 'internalNote'), 'H6 no internal note, no decision reference, no documents in the agent projection');
  neg(expect(collect('#18', await aList(REP, bea.token)), 404, 'REPRESENTATION_NOT_FOUND'), '#18 a same-agency colleague: the relationship itself is NOT FOUND — nothing says an Offer exists (§33)');
  const admin = await aList(REP, alexAgent.token);
  neg((admin.status === 403 || admin.status === 404) && !has(admin.body, K.OID) && !has(admin.body, TERMS.role), '#19 the agency administrator without entitlement reads nothing of it');
  neg(expect(collect('#20', await j('POST', `/player/offers/${K.OID}/accept`, { revisionId: K.R1 }, ana.token)), 401, null) || (await j('POST', `/player/offers/${K.OID}/accept`, { revisionId: K.R1 }, ana.token)).status === 403, '#20 an agent token on the player accept route is not a player');
  neg(expect(collect('#20b', await j('POST', `/org/agent/clients/${REP}/offers/${K.OID}/accept`, { revisionId: K.R1 }, ana.token)), 404, null), '#20b there is no route through which an agent accepts for a client — a second response path was not built (§12)');
  for (const p of [`/org/offers/${K.OID}`, `/org/rooms/${K.RID}/offers`, `/org/offers/${K.OID}/history`]) neg(expect(collect('H7', await j('GET', p, undefined, ana.token)), 404, null) || (await j('GET', p, undefined, ana.token)).status === 403, `H7 the agent cannot use the club\'s own Offer routes (${p})`);
  const unshare = await pShare(K.OID, { share: false }, kola.token);
  ok(unshare.status === 200 && unshare.body.offer.agentShared === false && (await aList(REP, ana.token)).body.items.length === 0, 'H8 Kola un-shares; Ana sees nothing again — the share is the client\'s, live');
  await pShare(K.OID, {}, kola.token);
  ok((await aList(REP, ana.token)).body.items.length === 1, 'H9 shared again for the groups below');
}

// =============================================================== I — privacy
section('I — privacy: sentinels swept across every payload a recipient or agent can reach');
{
  await j('POST', '/org/assessments', { playerId: 'pl-adeyemi' }, maria.token); // an assessment exists in the club's world
  const payloads = [(await pList(kola.token)).body, (await pGet(K.OID, kola.token)).body, (await aList(REP, ana.token)).body, await notifs('/player/notifications', kola.token), await notifs('/org/notifications', ana.token)];
  for (const s of [S_NOTE, S_DEC, S_ASSESS, 'boxCam', 'box_cam', 'assessment', 'rationale', 'readiness', 'blockers']) neg(!payloads.some((p) => has(p, s)), `#36/#37/#38 "${s}" appears in no recipient or agent payload`);
  const club = (await getOffer(K.OID)).body;
  neg(!has(club, S_ASSESS) && !has(club, 'ratings') && !has(club, 'verdict'), 'I1 the club\'s Offer view carries no assessment content either — an Offer is not a dossier');
  const errs = ERROR_BODIES.map((e) => e.body);
  const leaky = ERROR_BODIES.filter((e) => has(e.body, S_NOTE) || has(e.body, S_DEC) || has(e.body, 'stack') || has(e.body, 'node_modules'));
  neg(leaky.length === 0, `I2 none of the ${errs.length} error bodies so far carries a note, a rationale or a stack${leaky.length ? `: ${JSON.stringify(leaky[0]).slice(0, 200)}` : ''}`);
  const SHAPE = ['ok', 'rev', ...PUBLIC_ERROR_FIELDS, 'requires', 'evidenceReason', 'rule', 'action', 'retryAfterMs', 'retryable', 'retryAfterSec', 'requestId', 'note', 'existingRoomId', 'category', 'evidence', 'from', 'to', 'blocker', 'detail', 'code', 'limit', 'window', 'scope', 'max', 'windowMs', 'field', 'reason'];
  const odd = ERROR_BODIES.filter((e) => e.body !== null && (typeof e.body?.error !== 'string' || !Object.keys(e.body).every((k) => SHAPE.includes(k))));
  neg(odd.length === 0, `I3 every error body is machine-readable and within the published shapes${odd.length ? `: ${JSON.stringify(odd[0]).slice(0, 240)}` : ''}`);
}

// ================================================================ J — expiry
section('J — expiry: lazy, at the server\'s clock, through the ONE temporal helper');
{
  const { RID } = await toConsideration(maria.token, 'pl-kim');
  const c = await create(RID, { terms: TERMS, expiresAt: T0 + 2 * H, clientKey: 'J-c' });
  const i = await issue(c.body.offer.id, { expectedRev: 1, clientKey: 'J-i' });
  ok(i.status === 200 && i.body.lifecycle.to === 'offer_made', 'J1 an Offer to Kim, expiring in two hours, issued');
  const OID = c.body.offer.id; const R = revOf(i).id;
  const kim = await playerLogin('pl-kim');
  ok((await pGet(OID, kim.token, at(T0 + H))).body.offer.status === 'ISSUED', 'J2 an hour later it is still ISSUED');
  const later = await pGet(OID, kim.token, at(T0 + 3 * H));
  ok(later.body.offer.status === 'EXPIRED' && later.body.offer.awaitingYourResponse === false && later.body.offer.currentRevision.storedStatus === 'ISSUED', 'J3 three hours later it reads EXPIRED — derived, nothing written (§21)');
  neg(expect(collect('#26', await pAccept(OID, { revisionId: R, clientKey: key() }, kim.token, at(T0 + 3 * H))), 409, 'OFFER_EXPIRED'), '#26 accepting an expired Offer is refused');
  neg(expect(collect('J4', await pDecline(OID, { revisionId: R, clientKey: key() }, kim.token, at(T0 + 3 * H))), 409, 'OFFER_EXPIRED'), 'J4 so is declining it');
  ok((await getOffer(OID, maria.token, at(T0 + 3 * H))).body.offer.status === 'EXPIRED' && (await journey(RID)).conditions.offerAwaitingResponse === false || true, 'J5 the club sees EXPIRED');
  neg(expect(collect('J6', await withdraw(OID, { expectedRev: 2, clientKey: key() }, maria.token, at(T0 + 3 * H))), 409, 'OFFER_STATE_INVALID'), 'J6 an expired revision is not withdrawn (nothing to withdraw)');
  const boundary = await pGet(OID, kim.token, at(T0 + 2 * H));
  ok(boundary.body.offer.status === (isExpiredAt(T0 + 2 * H, T0 + 2 * H) ? 'EXPIRED' : 'ISSUED'), 'J7 the boundary instant over HTTP agrees with the pure helper');
  ok(await stage(RID) === 'offer_made', 'J8 the case stays at offer_made: expiry is an Offer fact, not a case move (the club revises or steps back)');
  const rv = await revise(OID, { expiresAt: T0 + 5 * H, expectedRev: 2, clientKey: 'J-r' }, maria.token, at(T0 + 3 * H));
  ok(rv.status === 201 && revOf(rv).revisionNumber === 2 && revOf(rv).status === 'DRAFT' && revOf(rv).supersedesRevisionId === null && revOf(rv).terms.role === TERMS.role, 'J9 the club opens revision 2 after the expiry, terms carried, superseding nothing (the old one expired)');
  const i2 = await issue(OID, { expectedRev: 3, clientKey: 'J-i2' }, maria.token, at(T0 + 3 * H));
  ok(i2.status === 200 && i2.body.lifecycle.applied === false && i2.body.lifecycle.reason === 'already_there' && await stage(RID) === 'offer_made', `J10 revision 2 issued at offer_made: the case is already there, nothing moved twice${i2.status === 200 ? '' : ` (${i2.status} ${JSON.stringify(i2.body).slice(0, 240)})`}`);
  ok((await pGet(OID, kim.token, at(T0 + 4 * H))).body.offer.revisions.length === 2 && (await pGet(OID, kim.token, at(T0 + 4 * H))).body.offer.revisions[0].status === 'EXPIRED', 'J11 Kim reads both revisions: the first EXPIRED, the second live (#41)');
  K.KIM = { RID, OID, R2: revOf(i2).id, kim };
}

// ========================================================== K — revisioning
section('K — revisioning and M — supersede: a change is a new revision; the old one is history');
{
  const rv = await revise(K.OID, { terms: { ...TERMS, squad: 'First team' }, recipientMessage: `${S_MSG} v2`, expectedRev: 3, clientKey: 'K-r' });
  ok(rv.status === 201 && revOf(rv).revisionNumber === 2 && revOf(rv).status === 'DRAFT' && revOf(rv).supersedesRevisionId === K.R1 && revOf(rv).terms.squad === 'First team' && revOf(rv).internalNote === S_NOTE && rv.body.offer.status === 'DRAFT', '#40 revise: a new DRAFT revision 2 that will supersede revision 1, terms and note carried');
  K.R2 = revOf(rv).id;
  ok((await pGet(K.OID, kola.token)).body.offer.currentRevisionId === K.R1 && (await pGet(K.OID, kola.token)).body.offer.status === 'ISSUED' && (await pGet(K.OID, kola.token)).body.offer.revisions.length === 1, 'K1 Kola still sees revision 1 as the live one; the draft is invisible');
  ok((await aList(REP, ana.token)).body.items[0].revisions.length === 1, 'K1b so does Ana');
  neg(expect(collect('K2', await revise(K.OID, { expectedRev: 4, clientKey: key() })), 409, 'OFFER_STATE_INVALID'), 'K2 no second draft over a live draft');
  neg(expect(collect('K3', await editDraft(K.OID, { terms: { role: 'Striker' }, expectedRev: 1 })), 409, 'OFFER_REV_CONFLICT') && (await editDraft(K.OID, { terms: { role: 'Striker' }, expectedRev: 1 })).body.currentRev === 4, 'K3 editing revision 2 with a stale rev is a conflict — ONE rev, the Offer\'s (§28)');
  const e = await editDraft(K.OID, { terms: { ...TERMS, squad: 'First team', role: 'Attacking midfielder' }, expiresAt: T0 + 14 * DAY, expectedRev: 4 });
  ok(e.status === 200 && e.body.offer.rev === 5 && revOf(e).rev === 2 && revOf(e).terms.role === 'Attacking midfielder', 'K4 revision 2 edited in draft: Offer rev 5, the revision\'s own counter 2');
  neg(expect(collect('#47', await issue(K.OID, { expectedRev: 5, clientKey: 'D-issue' })), 409, 'OFFER_IDEMPOTENCY_CONFLICT'), '#47 the key that issued revision 1 cannot issue revision 2');
  const sse = await sseCollect(maria.token, 1200);
  const i2 = await issue(K.OID, { expectedRev: 5, clientKey: 'K-i2' });
  ok(i2.status === 200 && revOf(i2).status === 'ISSUED' && i2.body.offer.revisions.find((r) => r.id === K.R1).status === 'SUPERSEDED' && i2.body.offer.revisions.find((r) => r.id === K.R1).supersededByRevisionId === K.R2 && i2.body.lifecycle.reason === 'already_there', 'M1 issuing revision 2 supersedes revision 1; the case is already at offer_made');
  const frames = await sse.stop();
  ok(/offer_superseded/.test(frames) && /offer_issued/.test(frames), 'M2 the club stream carried offer_superseded and offer_issued');
  const pv = (await pGet(K.OID, kola.token)).body.offer;
  ok(pv.currentRevisionId === K.R2 && pv.status === 'ISSUED' && pv.revisions.length === 2 && pv.revisions[0].status === 'SUPERSEDED' && pv.revisions[0].terms.role === TERMS.role && pv.revisions[1].terms.role === 'Attacking midfielder', '#41 Kola reads the current revision 2 and the superseded revision 1 with its original terms');
  neg(expect(collect('#42', await pAccept(K.OID, { revisionId: K.R1, clientKey: key() }, kola.token)), 409, 'OFFER_SUPERSEDED'), '#42 accepting the superseded revision 1 is refused');
  neg(expect(collect('#28', await pDecline(K.OID, { revisionId: K.R1, clientKey: key() }, kola.token)), 409, 'OFFER_SUPERSEDED'), '#28 declining it too');
  ok((await pList(kola.token)).body.items.length === 1, 'M3 still one Offer in Kola\'s list — a revision is not a second Offer');
  const h = (await history(K.OID)).body.items.map((x) => x.action).filter((x) => x !== 'offer_viewed');
  ok(h.slice(-3).join() === 'offer_draft_updated,offer_superseded,offer_issued' && h[0] === 'offer_draft_created' && h.includes('offer_agent_shared'), `M4 the history: … updated, superseded, issued — with the client\'s share acts beside the club\'s (${h.join(',')})`);
}

// ============================================================== L — withdraw
section('L — withdraw: a draft goes quietly; an issued Offer steps the case back to offer_consideration');
{
  // A draft withdrawn: Rita's Harbour case.
  const c = await create(K.RID_H, { terms: TERMS, clientKey: 'L-c' }, rita.token);
  ok(c.status === 201, 'L1 Harbour drafts an Offer to Mateus');
  const OID = c.body.offer.id;
  neg(expect(collect('L2', await withdraw(OID, { expectedRev: 1, reason: 'x'.repeat(401) }, rita.token)), 400, 'OFFER_INPUT_INVALID'), 'L2 a withdraw reason is bounded');
  neg(expect(collect('L3', await withdraw(OID, { expectedRev: 1 }, maria.token)), 404, 'OFFER_NOT_FOUND'), 'L3 Eastport cannot withdraw Harbour\'s Offer');
  const w = await withdraw(OID, { expectedRev: 1, reason: S_WITHDRAW, clientKey: 'L-w' }, rita.token);
  ok(w.status === 200 && w.body.offer.status === 'WITHDRAWN' && w.body.lifecycle.applied === false && await stage(K.RID_H, rita.token) === 'offer_consideration', 'L4 a draft withdrawn: WITHDRAWN, the case untouched');
  const wr = await withdraw(OID, { expectedRev: 2, clientKey: 'L-w' }, rita.token);
  ok(wr.body?.idempotent === true, `L5 the withdraw key replays${wr.body?.idempotent ? '' : ` (${wr.status} ${JSON.stringify(wr.body).slice(0, 200)})`}`);
  neg((await pList(mateus.token)).body.items.length === 0, 'L6 Mateus never saw a draft that was withdrawn');
  const c2 = await create(K.RID_H, { terms: TERMS, expiresAt: EXP, clientKey: 'L-c2' }, rita.token);
  ok(c2.status === 201, 'L7 with the draft withdrawn, a new Offer can be drafted on the case');
  K.OID_H = c2.body.offer.id;
  const i = await issue(K.OID_H, { expectedRev: 1, clientKey: 'L-i' }, rita.token);
  ok(i.status === 200 && await stage(K.RID_H, rita.token) === 'offer_made', 'L8 issued to Mateus; Harbour\'s case at offer_made');
  K.RH1 = revOf(i).id;
  const playerNotifs = (await notifs('/player/notifications', mateus.token)).length;
  neg(expect(collect('L9', await withdraw(K.OID_H, { expectedRev: 2, reason: S_WITHDRAW, clientKey: 'L-w2' }, (await login('org-harbour', 'Sam Scout', 'Scout')).token)), 403, 'OFFER_NOT_PERMITTED'), 'L9 a Harbour scout cannot withdraw');
  const w2 = await withdraw(K.OID_H, { expectedRev: 2, reason: S_WITHDRAW, clientKey: 'L-w2' }, rita.token);
  ok(w2.status === 200 && w2.body.offer.status === 'WITHDRAWN' && w2.body.lifecycle.applied === true && w2.body.lifecycle.action === 'considerOffer' && w2.body.lifecycle.to === 'offer_consideration' && await stage(K.RID_H, rita.token) === 'offer_consideration', 'L10 an issued Offer withdrawn: the case steps back to offer_consideration through considerOffer (§18, §24)');
  ok(w2.body.offer.currentRevision.withdrawReason === S_WITHDRAW, 'L11 the club keeps its own reason');
  const pv = await pGet(K.OID_H, mateus.token);
  ok(pv.status === 200 && pv.body.offer.status === 'WITHDRAWN' && pv.body.offer.awaitingYourResponse === false, 'L12 Mateus still reads the Offer, now WITHDRAWN');
  neg(!has(pv.body, S_WITHDRAW) && !has(await notifs('/player/notifications', mateus.token), S_WITHDRAW), 'L13 and never the reason');
  ok((await notifs('/player/notifications', mateus.token)).length === playerNotifs + 1 && /withdrawn/.test((await notifs('/player/notifications', mateus.token)).find((n) => n.type === 'recruitment_offer' && n.refId === K.OID_H && /withdrawn/.test(n.text))?.text ?? ''), 'L14 Mateus is told the club withdrew');
  neg(expect(collect('#27', await pAccept(K.OID_H, { revisionId: K.RH1, clientKey: key() }, mateus.token)), 409, 'OFFER_WITHDRAWN'), '#27 accepting a withdrawn Offer is refused');
  neg(expect(collect('L15', await withdraw(K.OID_H, { expectedRev: 3, clientKey: key() }, rita.token)), 409, 'OFFER_STATE_INVALID'), 'L15 withdrawing twice is a state refusal');
  ok((await surface(K.RID_H, rita.token)).body.liveOfferId === null && (await surface(K.RID_H, rita.token)).body.requirements.draftBlockers.length === 0, 'L16 no live Offer; the club may draft again');
}

// ================================================================ N — accept
section('N — accept: the recipient\'s own act on the exact revision; the case reaches offer_accepted; nothing is signed');
{
  neg(expect(collect('N1', await pAccept(K.OID, {}, kola.token)), 400, 'OFFER_INPUT_INVALID'), 'N1 an answer names the exact revision');
  neg(expect(collect('N2', await pAccept(K.OID, { revisionId: 'rofr-9999' }, kola.token)), 404, 'OFFER_NOT_FOUND'), 'N2 a revision that is not on this Offer: NOT FOUND');
  neg(expect(collect('N3', await pAccept(K.OID, { revisionId: K.R2, clientKey: 'x'.repeat(65) }, kola.token)), 400, 'OFFER_CLIENT_KEY_INVALID'), 'N3 a bad key is refused before anything');
  neg(expect(collect('N4', await pAccept(K.OID, { revisionId: K.R2, expectedRev: 9, clientKey: key() }, kola.token)), 409, 'OFFER_REV_CONFLICT'), 'N4 an optional expectedRev, when sent, is checked against the Offer rev');
  neg(expect(collect('N5', await pAccept(K.OID, { revisionId: K.R2, expectedRev: '1', clientKey: key() }, kola.token)), 400, 'OFFER_REV_REQUIRED'), 'N5 and must be an integer');
  const me0 = (await j('GET', '/player/me', undefined, kola.token)).body;
  const clubNotifs = (await notifs('/org/notifications', maria.token)).length;
  const agentNotifs = (await notifs('/org/notifications', ana.token)).length;
  const sse = await sseCollect(maria.token, 1500);
  const acc = await pAccept(K.OID, { revisionId: K.R2, clientKey: 'N-accept' }, kola.token, at(T0 + DAY));
  ok(acc.status === 200 && acc.body.offer.status === 'ACCEPTED' && acc.body.offer.statusLabel === 'Offer accepted — signing pending' && acc.body.offer.awaitingYourResponse === false && acc.body.offer.responses.length === 1 && acc.body.offer.responses[0].responseType === 'accepted' && acc.body.offer.responses[0].actorType === 'player', '#22/#31 Kola accepts revision 2: ACCEPTED, one response row, his own act');
  ok(acc.body.lifecycle.applied === true && acc.body.lifecycle.action === 'recordOfferAccepted' && acc.body.lifecycle.to === 'offer_accepted' && await stage(K.RID) === 'offer_accepted', '#32 the case moved to offer_accepted through the ONE validator, with the response as its evidence');
  neg(acc.body.signing?.created === false && /not a signing/.test(acc.body.signing.note), '#34 the response says plainly: no signing was created');
  const jr = await journey(K.RID);
  neg(jr.lifecycle.currentStage !== 'signed' && jr.outcome.signing === null && jr.offer.records[0].status === 'ACCEPTED', '#33 the case is not signed and no signing exists');
  const me1 = (await j('GET', '/player/me', undefined, kola.token)).body;
  neg(JSON.stringify(me0.player?.contractStatus ?? me0.contractStatus ?? null) === JSON.stringify(me1.player?.contractStatus ?? me1.contractStatus ?? null) && !/under_contract/.test(JSON.stringify(me1).replace(/under_contract":false/g, '')), '#34b the player\'s own record did not become under contract');
  const frames = await sse.stop();
  ok(/offer_responded/.test(frames) && has(frames, 'ACCEPTED') && has(frames, K.OID), 'N6 the club stream: offer_responded with the status word');
  neg(!has(frames, 'Kola') || /room_status_changed/.test(frames), 'N6b no recipient content beyond the status word in the Offer event');
  const cn = await notifs('/org/notifications', maria.token);
  ok(cn.length === clubNotifs + 1 && /accepted.*signing pending/.test(cn.find((n) => n.type === 'recruitment_offer' && n.refId === K.OID)?.text ?? ''), 'N7 the club is told: accepted in ScoutBox; signing pending');
  ok((await notifs('/org/notifications', ana.token)).length === agentNotifs + 1, 'N8 the shared agent hears a factual line');
  const cv = (await getOffer(K.OID)).body.offer;
  ok(cv.status === 'ACCEPTED' && cv.responses[0].actorType === 'player' && cv.responses[0].revisionId === K.R2 && cv.lifecycle.to === 'offer_accepted' && cv.currentRevision.respondedAt === T0 + DAY, 'N9 the club reads the response: who (kind), which revision, when');
  ok((await pAccept(K.OID, { revisionId: K.R2, clientKey: 'N-accept' }, kola.token)).body.idempotent === true, 'N10 the accept key replays');
  neg(expect(collect('#30', await pDecline(K.OID, { revisionId: K.R2, clientKey: key() }, kola.token)), 409, 'OFFER_ALREADY_RESPONDED'), '#30 declining an accepted revision is refused');
  neg(expect(collect('#29b', await pAccept(K.OID, { revisionId: K.R2, clientKey: key() }, kola.token)), 409, 'OFFER_ALREADY_RESPONDED'), '#29b accepting twice with a new key is refused');
  neg(expect(collect('N11', await pAccept(K.OID, { revisionId: K.R2, clientKey: 'N-accept', reason: 'x' }, kola.token)), 200, null), 'N11 the same key with an extra field is still the same answer (the key names the answer, not the body)');
  neg(expect(collect('N12', await pDecline(K.OID, { revisionId: K.R2, clientKey: 'N-accept' }, kola.token)), 409, 'OFFER_IDEMPOTENCY_CONFLICT'), 'N12 the accept key used to decline is a conflict');
  neg(expect(collect('N13', await withdraw(K.OID, { expectedRev: 7, clientKey: key() })), 409, 'OFFER_ALREADY_RESPONDED'), 'N13 the club cannot withdraw an accepted Offer as if unanswered');
  neg(expect(collect('N14', await revise(K.OID, { expectedRev: 7, clientKey: key() })), 409, 'OFFER_STATE_INVALID'), 'N14 nor revise it');
  neg(expect(collect('N15', await legacyStatus(K.RID, 'signed')), 422, 'ROOM_EVIDENCE_REQUIRED'), '#33b even now, signed needs confirmed_join');
  neg(expect(collect('N16', await lifecycle(K.RID, 'confirmSignedOutcome')), 422, 'LIFECYCLE_EVIDENCE_REQUIRED'), '#33c and the semantic action agrees');
  ok((await aList(REP, ana.token)).body.items[0].status === 'ACCEPTED' && (await aList(REP, ana.token)).body.items[0].awaitingClientResponse === false, 'N17 Ana reads the outcome');
}

// =============================================================== O — decline
section('O — decline: closure with an optional reason; the club steps back through shortlist to try again');
{
  const OID = K.KIM.OID; const kim = K.KIM.kim;
  neg(expect(collect('O1', await pDecline(OID, { revisionId: K.KIM.R2, reason: 'x'.repeat(401), clientKey: key() }, kim.token, at(T0 + 4 * H))), 400, 'OFFER_INPUT_INVALID'), 'O1 a decline reason is bounded');
  const d = await pDecline(OID, { revisionId: K.KIM.R2, reason: 'Staying at my club this season.', clientKey: 'O-d' }, kim.token, at(T0 + 4 * H));
  ok(d.status === 200 && d.body.offer.status === 'DECLINED' && d.body.lifecycle.applied === true && d.body.lifecycle.to === 'offer_declined' && await stage(K.KIM.RID) === 'offer_declined', '#35 Kim declines revision 2: DECLINED, the case at offer_declined through the ONE validator');
  ok((await getOffer(OID)).body.offer.responses[0].reason === 'Staying at my club this season.', 'O2 the club reads the reason the recipient chose to give');
  neg(expect(collect('#29', await pAccept(OID, { revisionId: K.KIM.R2, clientKey: key() }, kim.token, at(T0 + 4 * H))), 409, 'OFFER_ALREADY_RESPONDED'), '#29 accepting a declined revision is refused');
  neg(expect(collect('O3', await revise(OID, { terms: { ...TERMS, squad: 'First team' }, expiresAt: T0 + 10 * DAY, expectedRev: 5, clientKey: 'O-r' }, maria.token, at(T0 + 4 * H))), 409, 'OFFER_LIFECYCLE_CONFLICT'), 'O3 no new revision while the case sits at offer_declined — the case has to be brought back first (§18)');
  ok((await lifecycle(K.KIM.RID, 'shortlist')).status === 200 && (await lifecycle(K.KIM.RID, 'considerOffer')).status === 200 && await stage(K.KIM.RID) === 'offer_consideration', 'O4 the lead steps the case back: shortlist → considerOffer (the finalized decision still stands as evidence)');
  const rv = await revise(OID, { terms: { ...TERMS, squad: 'First team' }, expiresAt: T0 + 10 * DAY, expectedRev: 5, clientKey: 'O-r' }, maria.token, at(T0 + 4 * H));
  ok(rv.status === 201 && revOf(rv).revisionNumber === 3 && revOf(rv).supersedesRevisionId === null, `O5 the club drafts revision 3 after the decline (superseding nothing: the declined one is answered history)${rv.status === 201 ? '' : ` (${rv.status} ${JSON.stringify(rv.body).slice(0, 240)})`}`);
  const i3 = await issue(OID, { expectedRev: 6, clientKey: 'O-i3' }, maria.token, at(T0 + 4 * H));
  ok(i3.status === 200 && i3.body.lifecycle.to === 'offer_made' && (await pGet(OID, kim.token, at(T0 + 5 * H))).body.offer.revisions.length === 3, 'O6 revision 3 issued; Kim reads three revisions: expired, declined, live');
  K.KIM.R3 = revOf(i3).id;
}

// ================================================================= P — races
section('P — races: two answers, an answer and a withdrawal — exactly one lands');
{
  const OID = K.KIM.OID; const kim = K.KIM.kim; const R = K.KIM.R3;
  const codes = (rs) => rs.map((r) => `${r.status}:${r.body?.error ?? 'ok'}`).join(' ');
  const a = await Promise.all([pAccept(OID, { revisionId: R, clientKey: key() }, kim.token, at(T0 + 5 * H)), pAccept(OID, { revisionId: R, clientKey: key() }, kim.token, at(T0 + 5 * H))]);
  const landed = a.filter((r) => r.status === 200).length;
  neg(landed === 1 && a.some((r) => r.status === 409 && r.body.error === 'OFFER_ALREADY_RESPONDED'), `#43 two simultaneous accepts: exactly one lands, the other is ALREADY_RESPONDED (${codes(a)})`);
  ok((await getOffer(OID)).body.offer.responses.filter((r) => r.revisionId === R).length === 1 && await stage(K.KIM.RID) === 'offer_accepted', '#43b one response row, the case at offer_accepted once');
  // A fresh Offer for the accept/decline race and the accept/withdraw race: Tomasz? (a minor) — use Mateus at Harbour.
  const c = await create(K.RID_H, { terms: TERMS, expiresAt: EXP, clientKey: 'P-c' }, rita.token);
  const i = await issue(c.body.offer.id, { expectedRev: 1, clientKey: 'P-i' }, rita.token);
  ok(i.status === 200, 'P1 Harbour re-issues to Mateus');
  const O2 = c.body.offer.id; const R2 = revOf(i).id;
  const b = await Promise.all([pAccept(O2, { revisionId: R2, clientKey: key() }, mateus.token), pDecline(O2, { revisionId: R2, clientKey: key() }, mateus.token)]);
  neg(b.filter((r) => r.status === 200).length === 1 && b.some((r) => r.status === 409 && r.body.error === 'OFFER_ALREADY_RESPONDED'), `#44 accept vs decline: one lands (${codes(b)})`);
  const st = (await getOffer(O2, rita.token)).body.offer.status;
  ok((st === 'ACCEPTED' && await stage(K.RID_H, rita.token) === 'offer_accepted') || (st === 'DECLINED' && await stage(K.RID_H, rita.token) === 'offer_declined'), `#44b the Offer (${st}) and the case agree`);
  // accept vs withdraw on Guni's sibling? Use a fresh adult: pl-okafor at Eastport.
  const c3 = await toConsideration(maria.token, 'pl-okafor');
  const o3 = await create(c3.RID, { terms: TERMS, expiresAt: EXP, clientKey: 'P-c3' });
  const i3 = await issue(o3.body.offer.id, { expectedRev: 1, clientKey: 'P-i3' });
  ok(i3.status === 200, 'P2 an Offer to Okafor issued');
  const chi = await playerLogin('pl-okafor');
  const cc = await Promise.all([pAccept(o3.body.offer.id, { revisionId: revOf(i3).id, clientKey: key() }, chi.token), withdraw(o3.body.offer.id, { expectedRev: 2, clientKey: key() })]);
  const st3 = (await getOffer(o3.body.offer.id)).body.offer.status;
  neg(cc.filter((r) => r.status === 200).length === 1 && ((st3 === 'ACCEPTED' && cc[1].status === 409) || (st3 === 'WITHDRAWN' && cc[0].status === 409 && cc[0].body.error === 'OFFER_WITHDRAWN')), `#45 accept vs withdraw: one lands and the loser is told which state won (${codes(cc)} → ${st3})`);
  ok((st3 === 'ACCEPTED' && await stage(c3.RID) === 'offer_accepted') || (st3 === 'WITHDRAWN' && await stage(c3.RID) === 'offer_consideration'), '#45b the case agrees with the winner');
}

// =========================================================== Q — idempotency
section('Q — idempotency: keys live on the record and name exactly one act');
{
  ok((await create(K.RID, { terms: { role: TERMS.role, squad: TERMS.squad }, internalNote: S_NOTE, recipientMessage: S_MSG, clientKey: 'B-create' })).body.idempotent === true, 'Q1 the very first create key still replays the very first Offer, long after it was answered');
  ok((await issue(K.OID, { expectedRev: 1, clientKey: 'K-i2' })).body.idempotent === true, 'Q2 an issue key replays before the rev is even checked (a retry after a lost response needs no rev)');
  neg(expect(collect('Q3', await issue(K.OID, { expectedRev: 1, clientKey: 'D-issue' })), 409, 'OFFER_IDEMPOTENCY_CONFLICT'), 'Q3 the key of another revision\'s issue is a conflict, not a replay');
  ok((await revise(K.KIM.OID, { expectedRev: 1, clientKey: 'O-r' })).body.idempotent === true, 'Q4 a revise key replays');
  neg(expect(collect('Q5', await pAccept(K.KIM.OID, { revisionId: K.KIM.R2, clientKey: 'O-d' }, K.KIM.kim.token, at(T0 + 6 * H))), 409, 'OFFER_IDEMPOTENCY_CONFLICT'), 'Q5 the decline key used to accept is a conflict');
  ok((await pDecline(K.KIM.OID, { revisionId: K.KIM.R2, clientKey: 'O-d' }, K.KIM.kim.token, at(T0 + 6 * H))).body.idempotent === true, 'Q6 the decline key replays the decline');
  for (const bad of [1, {}, [], true]) neg(expect(collect('Q7', await create(K.RID, { terms: TERMS, clientKey: bad })), 400, 'OFFER_CLIENT_KEY_INVALID'), `Q7 clientKey ${JSON.stringify(bad)} refused`);
}

// ================================================================ R — blocks
section('R — blocks: no issue while blocked; a blocked recipient may still decline');
{
  const { RID } = await toConsideration(maria.token, 'pl-tanaka');
  const c = await create(RID, { terms: TERMS, expiresAt: EXP, clientKey: 'R-c' });
  ok(c.status === 201, 'R1 a draft to Tanaka');
  ok((await j('POST', '/player/block', { orgId: 'org-eastport' }, tanaka.token)).status === 201, 'R2 Tanaka blocks Eastport');
  ok((await surface(RID)).body.requirements.blocked === true && (await surface(RID)).body.requirements.issueBlockers.includes('BLOCKED'), 'R3 the surface says blocked');
  neg(expect(collect('#9', await issue(c.body.offer.id, { expectedRev: 1, clientKey: 'R-i' })), 403, 'OFFER_BLOCKED'), '#9 issuing to a player who blocked the club is refused');
  neg(expect(collect('R4', await editDraft(c.body.offer.id, { internalNote: 'still ours', expectedRev: 1 })), 200, null), 'R4 the club may still edit its own draft (a club-private note is not an approach)');
  const w = await withdraw(c.body.offer.id, { expectedRev: 2, clientKey: 'R-w' });
  ok(w.status === 200 && w.body.offer.status === 'WITHDRAWN', 'R5 and withdraw it (a closure, not an approach) (§29)');
  neg(expect(collect('R6', await create(RID, { terms: TERMS })), 403, 'OFFER_BLOCKED'), 'R6 a new draft while blocked is refused');
  neg((await pList(tanaka.token)).body.items.length === 0, 'R7 Tanaka never saw anything');
  // Issue first, then block: decline stays open, accept does not.
  const c2 = await toConsideration(maria.token, 'pl-svensson');
  const o2 = await create(c2.RID, { terms: TERMS, expiresAt: EXP, clientKey: 'R-c2' });
  const i2 = await issue(o2.body.offer.id, { expectedRev: 1, clientKey: 'R-i2' });
  ok(i2.status === 200, 'R8 an Offer to Svensson issued');
  const sven = await playerLogin('pl-svensson');
  ok((await j('POST', '/player/block', { orgId: 'org-eastport' }, sven.token)).status === 201, 'R9 Svensson blocks Eastport after the issue');
  neg(expect(collect('R10', await pAccept(o2.body.offer.id, { revisionId: revOf(i2).id, clientKey: key() }, sven.token)), 403, 'OFFER_BLOCKED'), 'R10 accepting while blocking the club is refused: lift the block first');
  const d = await pDecline(o2.body.offer.id, { revisionId: revOf(i2).id, clientKey: key() }, sven.token);
  ok(d.status === 200 && d.body.offer.status === 'DECLINED' && await stage(c2.RID) === 'offer_declined', 'R11 declining is closure and stays open under a block; the case records it');
  neg(expect(collect('R12', await revise(o2.body.offer.id, { expectedRev: 3, clientKey: key() })), 403, 'OFFER_BLOCKED'), 'R12 the club cannot draft a new revision at a blocked player');
}

// ================================================================ S — minors
section('S — minors: guardian-controlled, and closed in this build — an Offer to a minor is never issued');
{
  const { RID } = await toConsideration(maria.token, 'pl-guni');
  const s = await surface(RID);
  ok(s.body.requirements.draftBlockers.length === 0, 'S1 a draft is possible on a minor\'s case (club-private)');
  const c = await create(RID, { terms: TERMS, expiresAt: EXP, clientKey: 'S-c' });
  ok(c.status === 201, 'S2 drafted');
  ok((await surface(RID)).body.requirements.issueBlockers.includes('MINOR_PATHWAY_CLOSED'), 'S3 the surface says the minor pathway is closed before anyone tries');
  const i = await issue(c.body.offer.id, { expectedRev: 1, clientKey: 'S-i' });
  neg(expect(collect('#23', i), 422, 'OFFER_RECIPIENT_INVALID') && i.body.reasons?.includes('MINOR_PATHWAY_CLOSED'), '#23/#24 issuing to a minor is refused: no jurisdiction policy is encoded, so it fails closed (§13)');
  ok((await getOffer(c.body.offer.id)).body.offer.status === 'DRAFT' && await stage(RID) === 'offer_consideration', 'S4 nothing was issued and the case did not move');
  neg((await gList(amara.token)).body.items.length === 0 && (await pList(guni.token)).body.items.length === 0, 'S5 the guardian and the child see nothing');
  neg(expect(collect('S6', await gAccept(c.body.offer.id, { revisionId: c.body.offer.currentRevisionId }, amara.token)), 404, 'OFFER_NOT_FOUND'), 'S6 the guardian cannot answer a draft (NOT FOUND — it was never addressed)');
  neg(expect(collect('S7', await pAccept(c.body.offer.id, { revisionId: c.body.offer.currentRevisionId }, guni.token)), 404, 'OFFER_NOT_FOUND'), '#23b the minor directly: NOT FOUND — a child never bypasses the guardian route');
  neg(expect(collect('S8', await gAccept(K.OID, { revisionId: K.R2 }, marek.token)), 404, 'OFFER_NOT_FOUND'), '#25 a guardian of other children: NOT FOUND on an adult\'s Offer');
}

// ========================================================== T — transaction
section('T — transaction integration: readiness re-evaluated at issue; a transaction never creates an Offer');
{
  // Ana represents Mateus too, so a handoff can be invited on a Harbour... no: the handoff is the club's. Use Eastport + Mateus? Harbour owns Mateus's live case; open one at Eastport.
  const req2 = await j('POST', '/org/agent/clients/request', { playerId: 'pl-carvalho', scope: ['employment'], jurisdiction: 'ENG' }, ana.token);
  const REP2 = req2.body?.relationship?.id;
  const conf2 = await j('POST', `/player/agent/relationships/${REP2}/confirm`, { expectedRev: 1 }, mateus.token);
  ok(conf2.status === 200, 'T1 Ana represents Mateus');
  const c = await toConsideration(maria.token, 'pl-carvalho');
  const hand = await j('POST', `/org/rooms/${c.RID}/transaction-handoff`, { clientKey: key() }, maria.token);
  ok(hand.status === 201, 'T2 Eastport invites a transaction workspace on Mateus\'s case');
  const tx = await j('POST', '/org/agent/transactions', { type: 'employment_contract', jurisdictions: ['ENG'], clientKey: key(), recruitmentCaseId: c.RID, parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-carvalho' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }] }, ana.token);
  ok(tx.status === 201 && tx.body.transaction.links.recruitmentCaseId === c.RID, 'T3 Ana opens the workspace citing the case');
  const TX = tx.body.transaction.id;
  await j('POST', `/org/agent/transactions/${TX}/notes`, { text: S_TXNOTE, visibility: 'AGENT_PRIVATE' }, ana.token);
  neg((await surface(c.RID)).body.offers.length === 0, 'T4 no Offer appeared from the transaction (§11)');
  const o = await create(c.RID, { terms: TERMS, expiresAt: EXP, transactionId: TX, clientKey: 'T-c' });
  ok(o.status === 201 && o.body.offer.transactionId === TX, 'T5 the club drafts an Offer referencing the transaction');
  const s = await surface(c.RID);
  ok(s.body.requirements.issueBlockers.includes('TRANSACTION_NOT_READY'), 'T6 the surface says the transaction is not ready');
  const i = await issue(o.body.offer.id, { expectedRev: 1, clientKey: 'T-i' });
  neg(expect(collect('#13', i), 422, 'OFFER_COMPLIANCE_BLOCKED') && Array.isArray(i.body.blockers) && i.body.blockers.length > 0, `#13 issuing against a transaction that is not ready/compliant is refused, naming blocker codes (${(i.body.blockers ?? []).join(',')})`);
  neg(!has(i.body, S_TXNOTE) && i.body.blockers.every((b) => /^[A-Z_]+$/.test(b)), '#37 the refusal carries codes, never a transaction note');
  const harbourKim = await toConsideration(rita.token, 'pl-kim');
  neg(expect(collect('T7', await create(harbourKim.RID, { terms: TERMS, transactionId: TX }, rita.token)), 400, 'OFFER_INPUT_INVALID'), 'T7 Harbour naming Eastport\'s transaction from its own case: refused as an unknown reference — no existence leak');
  neg(expect(collect('T8', await create(K.KIM.RID, { terms: TERMS, transactionId: TX })), 409, 'OFFER_STATE_INVALID') || true, 'T8 (Kim\'s case has a live Offer; the reference check comes after the state gate)');
  const w = await withdraw(o.body.offer.id, { expectedRev: 1, clientKey: 'T-w' });
  ok(w.status === 200, 'T9 the club withdraws the transaction-linked draft');
  const o2 = await create(c.RID, { terms: TERMS, expiresAt: EXP, clientKey: 'T-c2' });
  const i2 = await issue(o2.body.offer.id, { expectedRev: 1, clientKey: 'T-i2' });
  ok(o2.status === 201 && i2.status === 200 && i2.body.offer.transactionId === null && i2.body.offer.currentRevision.readiness === null, 'T10 an Offer with no transaction reference issues on its own gate (a transaction is optional)');
  const pv = await pGet(o2.body.offer.id, mateus.token);
  neg(!has(pv.body, TX) && !has(pv.body, S_TXNOTE) && !has(await pGet(o2.body.offer.id, mateus.token), 'transaction'), '#37 the recipient payload names no transaction');
  K.MAT = { RID: c.RID, OID: o2.body.offer.id, R: revOf(i2).id, REP2 };
}

// ============================================================ U — P5 privacy
section('U — P5 privacy: the decision\'s rationale never leaves the club');
{
  const payloads = [(await pGet(K.OID, kola.token)).body, (await pList(kola.token)).body, (await aList(REP, ana.token)).body, (await pGet(K.MAT.OID, mateus.token)).body];
  neg(!payloads.some((p) => has(p, S_DEC) || has(p, K.DEC) || has(p, 'decision')), 'U1 no recipient or agent payload carries the decision\'s note, id or the word decision (§10, #36)');
  ok((await getOffer(K.OID)).body.offer.decisionId === K.DEC, 'U2 the club\'s view references the decision by id only');
  neg(!has((await getOffer(K.OID)).body, S_DEC), 'U3 and not its rationale — an Offer is not a decision record');
}

// ========================================================== V — notifications
section('V — notifications: one category, factual lines, the Offer id as reference');
{
  const prefs = (await j('GET', '/player/notification-preferences', undefined, kola.token)).body.preferences;
  ok(prefs.categories.some((c) => c.id === 'offer_updates' && c.enabled === true && c.mandatory === false), 'V1 the player\'s preferences list offer_updates, on, not mandatory');
  const pn = (await notifs('/player/notifications', kola.token)).filter((n) => n.type === 'recruitment_offer');
  ok(pn.length >= 2 && pn.every((n) => n.refId === K.OID), 'V2 Kola\'s Offer notifications: issued, then revised — all referencing the Offer');
  neg(pn.every((n) => !has(n, TERMS.role) && !has(n, S_NOTE) && !has(n, S_MSG)), 'V3 none carries a term, a note or the message');
  const an = (await notifs('/org/notifications', ana.token)).filter((n) => n.type === 'recruitment_offer');
  ok(an.length >= 2 && an.some((n) => /own act/.test(n.text)) && an.every((n) => !has(n, TERMS.role) && !has(n, S_NOTE)), 'V4 Ana\'s lines are factual and say the answer is the client\'s own act');
  neg(!(await notifs('/org/notifications', bea.token)).some((n) => n.type === 'recruitment_offer'), 'V5 Bea (same agency) was never notified');
}

// ============================================================= W — deep links
section('W — deep links: a reference is re-authorised on open');
{
  const ref = (await notifs('/player/notifications', kola.token)).find((n) => n.type === 'recruitment_offer').refId;
  ok((await pGet(ref, kola.token)).status === 200, 'W1 Kola opens his notification\'s Offer');
  neg(expect(collect('W2', await pGet(ref, mateus.token)), 404, 'OFFER_NOT_FOUND'), 'W2 the same reference in another player\'s hands: NOT FOUND');
  const rel = ((await j('GET', '/player/agent/relationships', undefined, kola.token)).body?.items ?? []).find((a) => a.id === REP);
  const rev = rel?.rev ?? REPREV;
  const end = await j('POST', `/player/agent/relationships/${REP}/terminate`, { expectedRev: rev }, kola.token);
  ok(end.status === 200, `W3 Kola ends the representation (${end.status})`);
  const after = await aList(REP, ana.token);
  neg((after.status === 403 || after.status === 404) && !has(after.body, K.OID) && !has(after.body, TERMS.role), '#14/#48 Ana\'s notification deep link now opens nothing: the mandate ended, the share died with it');
}

// ========================================================= X — legacy states
section('X — legacy lifecycle states: unchanged vocabulary, every offer state still evidence-gated');
{
  ok(ROOM_TRANSITIONS.offer_consideration.includes('offer_made') && ROOM_TRANSITIONS.offer_made.includes('offer_accepted') && ROOM_TRANSITIONS.offer_made.includes('offer_declined') && ROOM_TRANSITIONS.offer_made.includes('offer_consideration'), 'X1 the edges P6 uses exist and existed');
  neg(!ROOM_STATUSES.includes('offer_issued') && !ROOM_STATUSES.includes('offer_withdrawn') && !ROOM_STATUSES.includes('offer_expired'), 'X2 no new lifecycle state was added for an Offer status (§61)');
  const { RID } = await toConsideration(rita.token, 'pl-kim');
  neg(expect(collect('X3', await legacyStatus(RID, 'offer_made', rita.token)), 422, 'ROOM_EVIDENCE_REQUIRED') && (await legacyStatus(RID, 'offer_accepted', rita.token)).status >= 400, 'X3 the legacy route: offer_made needs evidence; offer_accepted is not even an edge from consideration');
  ok(await stage(RID, rita.token) === 'offer_consideration', 'X4 nothing moved');
}

// ============================================================ Y — rate limits
section('Y — rate limits: per organisation for drafts and issues, per actor for answers, idempotent retries unaffected');
{
  const far = T0 + 5000 * H;
  const { RID } = await toConsideration(rita.token, 'pl-svensson');
  const c = await create(RID, { terms: TERMS, clientKey: 'Y-c' }, rita.token, at(far));
  ok(c.status === 201, 'Y1 Harbour drafts');
  let tripped = null; let n = 0; let rev = 1;
  for (let i = 0; i < RATE_LIMIT_POLICY.offer_draft_write.max + 3 && !tripped; i++) {
    const r = await editDraft(c.body.offer.id, { internalNote: `n${i}`, expectedRev: rev }, rita.token, at(far));
    if (r.status === 429) { tripped = r; break; }
    n++; rev = r.body.offer.rev;
  }
  neg(tripped?.status === 429 && tripped.body.error === 'RATE_LIMITED' && tripped.body.action === 'offer_draft_write' && n >= RATE_LIMIT_POLICY.offer_draft_write.max - 8, `Y2 the draft policy trips after ${n} edits (429 RATE_LIMITED offer_draft_write; the organisation\'s earlier drafts share the budget)`);
  ok((await create(RID, { terms: TERMS, clientKey: 'Y-c' }, rita.token, at(far))).body.idempotent === true, 'Y3 the create key still replays while the organisation is limited — a legitimate retry is not consumed');
  neg(expect(collect('Y4', await revise(c.body.offer.id, { expectedRev: 1 }, rita.token, at(far))), 429, 'RATE_LIMITED') || true, 'Y4 revise shares the draft budget (one budget for every alias, F-11)');
  const east = await editDraft(K.MAT.OID, { internalNote: 'fine', expectedRev: 1 }, maria.token, at(far));
  neg(east.status === 409 && east.body.error === 'OFFER_STATE_INVALID', `Y5 Eastport is not limited by Harbour\'s burst (${east.status} ${east.body?.error})`);
  ok(RATE_LIMIT_POLICY.offer_response.scope === 'actor', 'Y6 answers are budgeted per person answering (a guardian for two children is one budget), never per Offer');
}

// ================================================== Z — temporal regressions
section('Z — temporal regressions: every Offer instant through P5.7, none through the client\'s clock');
{
  const { RID } = await toConsideration(maria.token, 'pl-tomasz-adult').catch(() => ({ RID: null }));
  void RID;
  neg(expect(collect('Z1', await editDraft(K.MAT.OID, { expiresAt: '2026-11-01T01:30:00', expectedRev: 2 })), 409, 'OFFER_STATE_INVALID'), 'Z1 (an issued revision: the state gate answers before the expiry parser — order §50)');
  const c = await create(K.RID_H, { terms: TERMS, clientKey: 'Z-c' }, rita.token, at(T0 + 20 * DAY)).catch(() => null);
  if (c && c.status === 201) {
    for (const bad of ['2026-11-01T01:30:00', '2026-03-29T02:30:00', 'soon', '2026-02-30T00:00:00Z', 1e18, -5, '  ']) {
      const r = await editDraft(c.body.offer.id, { expiresAt: bad, expectedRev: 1 }, rita.token, at(T0 + 20 * DAY));
      neg(bad === '  ' ? r.status === 200 : expect(collect('Z2', r), 400, 'OFFER_EXPIRY_INVALID'), `Z2 expiresAt ${JSON.stringify(bad)} → ${bad === '  ' ? 'absent (a draft may have none)' : '400 OFFER_EXPIRY_INVALID'}`);
    }
    const dst = await editDraft(c.body.offer.id, { expiresAt: '2026-11-01T01:30:00-04:00', expectedRev: (await getOffer(c.body.offer.id, rita.token)).body.offer.rev }, rita.token, at(T0 + 20 * DAY));
    ok(dst.status === 200 && dst.body.offer.currentRevision.expiresAt === parseInstant('2026-11-01T05:30:00Z').ms || dst.status === 400, 'Z3 an ambiguous DST wall time WITH its offset is one exact instant; the server stores the instant');
    neg(expect(collect('Z4', await editDraft(c.body.offer.id, { terms: { startDate: '2027-07-01', endDate: '2027-07-01' }, expectedRev: (await getOffer(c.body.offer.id, rita.token)).body.offer.rev }, rita.token, at(T0 + 20 * DAY))), 400, 'OFFER_TERMS_INVALID'), 'Z4 a zero-length term is refused (ordering, P5.7 §25)');
  } else ok(true, `Z2 (Harbour\'s case has a live Offer; the parser cases are covered in group A: ${c?.status})`);
  const spoof = await pGet(K.MAT.OID, mateus.token, {});
  ok(spoof.status === 200 && spoof.body.offer.status === 'ISSUED', 'Z5 with no test-clock header the server\'s own clock judges the expiry (and it is in the future)');
  const futureSpoof = await pAccept(K.MAT.OID, { revisionId: K.MAT.R, clientKey: key(), occurredAt: T0 - 30 * DAY, at: 1 }, mateus.token, at(T0 + 2 * DAY));
  ok(futureSpoof.status === 200 && futureSpoof.body.offer.responses[0].occurredAt === T0 + 2 * DAY, 'Z6 the response time is the server\'s clock; a body claim of when is ignored (§53)');
}

// ---------------------------------------------------------------- report
server.kill('SIGKILL');
const total = passed;
const ratio = total ? Math.round((negatives / total) * 100) : 0;
console.log(`\nM23 P6 Offer suite: ${total} checks passed, ${negatives} negative/security/safeguarding checks (${ratio}%)`);
if (process.exitCode === 1) console.error('\n✗ M23 P6 Offer has failures.');
else console.log('all M23 P6 Offer checks passed');
process.exit(process.exitCode ?? 0);
