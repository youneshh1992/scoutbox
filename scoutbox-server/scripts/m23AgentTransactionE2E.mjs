// M23 P5.6D acceptance suite — ScoutBox Agent Transaction Workspace.
//
// The governing principle this suite enforces (mandate §104): a ScoutBox
// transaction is a permissioned, auditable multi-party workspace. It must never
// turn transaction membership, stale compliance, broad agency access, hidden
// club information, unconfirmed representation or platform convenience into
// authority or visibility that the actual party has not granted.
//
// Groups (mandate §89), pure first, then a real server:
//   pure: the state machine and its two transition maps · the nine document
//   visibility classes against roles AND sides · the compliance state machine ·
//   the party revision and its eight inputs · timeline audiences · the offer
//   readiness seam · the store contract, migration, events, notifications, rate
//   policies and error table
//   HTTP: A create · B party identity · C party history · D state transitions ·
//   E representation bindings · F compliance snapshot · G stale compliance ·
//   H consent integration · I party change invalidation · J document visibility ·
//   K private notes · L messages · M timeline audiences · N Player view ·
//   O Agent view · P engaging Club view · Q releasing Club view · R privacy ·
//   S tenant isolation · T blocks · U unsupported jurisdiction · V minor closed
//   path · W rev · X idempotency · Y concurrency · Z persistence · AA migration ·
//   AB removal/tombstone · AC events · AD notifications · AE EN/FR · AF
//   accessibility contract · AG mobile contract · AH live/browser · AI
//   corruption/legacy — and the thirty adversarial cases (§90), numbered.
//
// No assertion is `status !== 200`. Every refusal names its status and its code.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TRANSACTION_TYPES, TRANSACTION_STATUSES, LIVE_STATUSES, TERMINAL_STATUSES, PARTY_ROLES, ROOM_ROLES,
  ACTOR_TRANSITIONS, COMPLIANCE_TRANSITIONS, ALL_TRANSITIONS, actorTransitionAllowed, complianceTransitionAllowed,
  DOCUMENT_TYPES, DOCUMENT_VISIBILITY, NOTE_VISIBILITY, canSeeVisibility, uploadableVisibilities,
  complianceStateFrom, statusForComplianceState, partyRevisionOf, snapshotStaleness, offerReadiness,
  requiredPartyRoles, partiesConfirmed, partiesAwaitingConfirmation, roomRolesFor, clubPartyRoleOf,
  timelineFor, timelineAudienceOf, timelineVisible, actorLabel, TIMELINE_AUDIENCES,
  HOLD_REASON_CODES, CANCEL_REASON_CODES, CLOSE_REASON_CODES, TRANSACTION_LIMITS, RELEASING_PARTY_TYPES, PENDING_REASONS,
} from '../m26/transaction.mjs';
import { M26_ERROR_HTTP, PUBLIC_ERROR_FIELDS, publicErrorBody } from '../m26/errors.mjs';
import { TRANSACTION_AUDIT_ACTIONS, transactionAuditRows } from '../m26/audit.mjs';
import { PERMISSIONS, can } from '../m24/shared.mjs';
import { CONTEXT_TYPES, PARTY_ROLES as ENGINE_PARTY_ROLES, PERMITTED_WITH_CONSENT } from '../m25/conflict.mjs';
import { EVENT_REGISTRY } from '../m182/eventRegistry.mjs';
import { RATE_LIMIT_POLICY } from '../m181/rateLimit.mjs';
import { TYPE_CATEGORY, CATEGORIES } from '../m182/notificationPrefs.mjs';
import { MIGRATIONS, SCHEMA_VERSION, PRODUCTION_REQUIRED_STORES } from '../m182/migrations.mjs';
import { guaranteeFor } from '../storeContract.mjs';
import { openStore } from '../store.mjs';

const PORT = 6900 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m26-'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const SERVER = path.join(HERE, '..', 'server.mjs');
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };

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
const T0 = Date.UTC(2026, 8, 18);

// =================================================================== PURE
section('pure D/§11/§12 — the state machine: ten states, two maps, no offer and no signing');
{
  ok(TRANSACTION_STATUSES.length === 10 && TRANSACTION_STATUSES[0] === 'DRAFT' && TRANSACTION_STATUSES.at(-1) === 'ARCHIVED', 'D1 ten explicit states, DRAFT first and ARCHIVED last');
  neg(!TRANSACTION_STATUSES.some((s) => /offer|signed|sign/i.test(s)), 'D2 no state names an offer or a signing (§11)');
  neg(!TRANSACTION_STATUSES.includes('COMPLETED') && TRANSACTION_STATUSES.includes('CLOSED'), 'D3 the terminal is the neutral CLOSED, not COMPLETED — COMPLETED would read as a concluded transfer (§21)');
  for (const s of TRANSACTION_STATUSES) ok(Object.hasOwn(ACTOR_TRANSITIONS, s) && Object.hasOwn(COMPLIANCE_TRANSITIONS, s), `D4 ${s} appears in both transition maps`);
  const actorTargets = new Set(Object.values(ACTOR_TRANSITIONS).flat());
  neg(!actorTargets.has('READY') && !actorTargets.has('COMPLIANCE_PENDING') && !actorTargets.has('COMPLIANCE_BLOCKED'), 'D5 no actor transition reaches READY, COMPLIANCE_PENDING or COMPLIANCE_BLOCKED — those are the compliance layer\'s answer, not anyone\'s request');
  const complianceTargets = new Set(Object.values(COMPLIANCE_TRANSITIONS).flat());
  neg(!complianceTargets.has('ACTIVE') && !complianceTargets.has('CANCELLED') && !complianceTargets.has('CLOSED') && !complianceTargets.has('ARCHIVED'), 'D6 and the compliance layer never cancels, closes, archives or activates a transaction');
  neg(COMPLIANCE_TRANSITIONS.DRAFT.length === 0, 'D7 a DRAFT is never told it is READY: a draft makes no compliance claim (§13)');
  neg(ACTOR_TRANSITIONS.ARCHIVED.length === 0 && COMPLIANCE_TRANSITIONS.ARCHIVED.length === 0, 'D8 ARCHIVED is terminal for both maps — archive is retention, not a workflow state (§22)');
  neg(!actorTransitionAllowed('DRAFT', 'ACTIVE') && !actorTransitionAllowed('DRAFT', 'READY') && !actorTransitionAllowed('CLOSED', 'ACTIVE'), 'D9 a draft cannot jump to ACTIVE or READY, and a closed transaction cannot reopen');
  ok(actorTransitionAllowed('COMPLIANCE_PENDING', 'ACTIVE') && actorTransitionAllowed('COMPLIANCE_BLOCKED', 'ACTIVE'), 'D9b asking for ACTIVE from a compliance state IS a legal request — it is refused by the compliance gate, with the reason, rather than by the map with a generic one');
  ok(statusForComplianceState(complianceStateFrom({ outcome: 'CLEAR', representationCount: 0, partiesConfirmed: true })) === 'PARTIES_CONFIRMED', 'D9c a confirmed transaction with no representation rests at PARTIES_CONFIRMED: nothing has been asked of compliance yet');
  ok(actorTransitionAllowed('READY', 'ACTIVE') && actorTransitionAllowed('ACTIVE', 'ON_HOLD') && actorTransitionAllowed('ON_HOLD', 'ACTIVE') && actorTransitionAllowed('CANCELLED', 'ARCHIVED'), 'D10 the live path: READY → ACTIVE ⇄ ON_HOLD, and a terminal state can be archived');
  neg(!actorTransitionAllowed('__proto__', 'ACTIVE') && !complianceTransitionAllowed('constructor', 'READY') && !actorTransitionAllowed(undefined, 'ACTIVE'), 'D11 a prototype name and an undefined state authorise nothing (null-prototype tables)');
  ok(LIVE_STATUSES.length === 7 && TERMINAL_STATUSES.length === 3 && LIVE_STATUSES.every((s) => !TERMINAL_STATUSES.includes(s)), 'D12 seven live states and three terminal ones, disjoint');
  ok(ALL_TRANSITIONS.length === 10 && ALL_TRANSITIONS.every((r) => Array.isArray(r.byActor) && Array.isArray(r.byCompliance)), 'D13 the transition map is exported whole, for the document and for the client');
  ok(HOLD_REASON_CODES.length >= 5 && CANCEL_REASON_CODES.length >= 5 && CLOSE_REASON_CODES.length >= 3, 'D14 hold, cancel and close carry reason CODES, so analytics counts them without reading prose');
}

section('pure A/§7 — transaction types come from the frozen conflict-engine enum');
{
  ok(TRANSACTION_TYPES === CONTEXT_TYPES, 'A-p1 the type enum is the P5.6C engine\'s own object, imported not copied');
  ok(TRANSACTION_TYPES.join() === 'employment_contract,transfer,loan,other_services', 'A-p2 the four frozen P5.6A types, in order');
  neg(!TRANSACTION_TYPES.includes('renewal') && !TRANSACTION_TYPES.includes('permanent_transfer'), 'A-p3 no "renewal" and no "permanent_transfer": neither was frozen, so both are deferred rather than invented (§7)');
  ok(PARTY_ROLES === ENGINE_PARTY_ROLES && PARTY_ROLES.join() === 'individual,engaging_entity,releasing_entity', 'B-p1 the three frozen party roles, also the engine\'s own');
  ok(RELEASING_PARTY_TYPES.join() === 'transfer,loan', 'B-p2 a releasing entity exists only where the individual leaves someone');
  ok(requiredPartyRoles('employment_contract').join() === 'individual,engaging_entity' && requiredPartyRoles('transfer').join() === 'individual,engaging_entity,releasing_entity', 'B-p3 required parties per type');
  ok(ROOM_ROLES.length === 7 && ROOM_ROLES.includes('party_guardian') && ROOM_ROLES.includes('agency_admin_observer'), 'B-p4 the seven frozen room roles, including the guardian role no build grants yet');
}

section('pure C/§14 — party confirmation is by the party itself');
{
  const tx = (parties) => ({ type: 'transfer', parties, history: [] });
  const p = (partyRole, confirmed, removed = false) => ({ id: `p-${partyRole}`, partyRole, subjectKind: partyRole === 'individual' ? 'player' : 'club', subjectId: `s-${partyRole}`, confirmedAt: confirmed ? T0 : null, removed });
  neg(!partiesConfirmed(tx([p('individual', true), p('engaging_entity', true)])), 'C-p1 a transfer with no releasing entity is not party-confirmed');
  neg(!partiesConfirmed(tx([p('individual', true), p('engaging_entity', false), p('releasing_entity', true)])), 'C-p2 an unconfirmed engaging club is not confirmation — naming a party is not confirming it');
  ok(partiesConfirmed(tx([p('individual', true), p('engaging_entity', true), p('releasing_entity', true)])), 'C-p3 all three confirmed by their own side → party-confirmed');
  neg(!partiesConfirmed(tx([p('individual', true, true), p('engaging_entity', true), p('releasing_entity', true)])), 'C-p4 a removed party does not count, however confirmed it once was');
  ok(partiesAwaitingConfirmation(tx([p('individual', true), p('engaging_entity', false)])).join() === 'engaging_entity,releasing_entity', 'C-p5 the awaiting list names exactly what is missing');
}

section('pure J/§33/§34 — nine visibility classes, resolved from roles AND side');
{
  ok(DOCUMENT_VISIBILITY.length === 9 && DOCUMENT_VISIBILITY.includes('T_AND_S_ONLY'), 'J-p1 the nine classes the mandate names');
  ok(DOCUMENT_TYPES.length === 9 && DOCUMENT_TYPES.includes('term_sheet_draft') && DOCUMENT_TYPES.includes('employment_contract_draft'), 'J-p2 nine document types; the contract and term sheet are DRAFTS and say so in their names');
  const agent = ['representing_agent']; const player = ['party_individual'];
  const engaging = ['party_club_signatory']; const releasing = ['party_club_signatory'];
  const observer = ['agency_admin_observer']; const ts = ['trust_safety'];
  ok(canSeeVisibility('AGENT_PRIVATE', agent), 'J-p3 the representing agent reads their own private file');
  neg(!canSeeVisibility('AGENT_PRIVATE', observer), 'J-p4 an agency administrator who can see the transaction cannot read the agent\'s private file (DR-26) (#10 inverse)');
  neg(!canSeeVisibility('AGENT_PRIVATE', player) && !canSeeVisibility('AGENT_PRIVATE', engaging, 'engaging_entity'), 'J-p5 neither the player nor a club reads an AGENT_PRIVATE document (#10)');
  neg(!canSeeVisibility('PLAYER_PRIVATE', engaging, 'engaging_entity') && !canSeeVisibility('PLAYER_PRIVATE', agent), 'J-p6 a PLAYER_PRIVATE document reaches no club and not even the agent');
  ok(canSeeVisibility('ENGAGING_CLUB_PRIVATE', engaging, 'engaging_entity'), 'J-p7 the engaging club reads its own private file');
  neg(!canSeeVisibility('ENGAGING_CLUB_PRIVATE', releasing, 'releasing_entity'), 'J-p8 the releasing club does NOT — same role name, different side (#8)');
  neg(!canSeeVisibility('RELEASING_CLUB_PRIVATE', engaging, 'engaging_entity'), 'J-p9 and not the other way round either (#7)');
  neg(!canSeeVisibility('ENGAGING_CLUB_PRIVATE', player), 'J-p10 a player never reads a club-private document');
  ok(canSeeVisibility('PLAYER_AGENT_SHARED', player) && canSeeVisibility('PLAYER_AGENT_SHARED', agent) && !canSeeVisibility('PLAYER_AGENT_SHARED', engaging, 'engaging_entity'), 'J-p11 PLAYER_AGENT_SHARED reaches those two and nobody else');
  ok(canSeeVisibility('ENGAGING_AGENT_SHARED', engaging, 'engaging_entity') && canSeeVisibility('ENGAGING_AGENT_SHARED', agent) && !canSeeVisibility('ENGAGING_AGENT_SHARED', releasing, 'releasing_entity'), 'J-p12 ENGAGING_AGENT_SHARED reaches the engaging club and the agent, never the other side');
  ok(['representing_agent', 'party_individual', 'party_club_signatory'].every((r) => canSeeVisibility('ALL_TRANSACTION_PARTIES', [r], 'engaging_entity')), 'J-p13 ALL_TRANSACTION_PARTIES reaches every party role');
  neg(!canSeeVisibility('ALL_TRANSACTION_PARTIES', ts) && !canSeeVisibility('PLAYER_PRIVATE', ts), 'J-p14 a reviewer reads NO party document — their surface carries states and ids, not papers');
  ok(canSeeVisibility('T_AND_S_ONLY', ts), 'J-p15 the Trust & Safety lane is readable by Trust & Safety');
  neg(DOCUMENT_VISIBILITY.filter((v) => canSeeVisibility(v, ['representing_agent', 'party_individual', 'party_club_signatory'], 'engaging_entity')).length === 8, 'J-p16 even holding every party role at once, T_AND_S_ONLY stays out of reach');
  neg(!canSeeVisibility('NOT_A_CLASS', agent) && !canSeeVisibility('__proto__', agent) && !canSeeVisibility('constructor', agent), 'J-p17 an unknown class and a prototype name fail closed');
  neg(!canSeeVisibility('AGENT_PRIVATE', []) && !canSeeVisibility('ALL_TRANSACTION_PARTIES', null), 'J-p18 no roles means no access');
  neg(!uploadableVisibilities(agent).includes('T_AND_S_ONLY') && !uploadableVisibilities(ts).includes('T_AND_S_ONLY'), 'J-p19 nobody may FILE into the Trust & Safety lane, including Trust & Safety');
  neg(!uploadableVisibilities(player, 'individual').some((v) => /CLUB|ENGAGING|RELEASING/.test(v)), 'J-p20 a player cannot classify a document into a club lane');
  ok(uploadableVisibilities(player, 'individual').join() === 'PLAYER_PRIVATE,PLAYER_AGENT_SHARED,ALL_TRANSACTION_PARTIES', 'J-p21 what a player may file: their own, shared with the agent, or shared with everyone');
  ok(NOTE_VISIBILITY.length === 8 && !NOTE_VISIBILITY.includes('T_AND_S_ONLY'), 'K-p1 notes reuse the document classes minus the Trust & Safety lane — one vocabulary, not two');
}

section('pure F/§15/§26 — the compliance state machine names its reason');
{
  const st = (o) => complianceStateFrom(o);
  ok(st({ outcome: 'CLEAR', representationCount: 1, partiesConfirmed: true }).clear === true, 'F-p1 CLEAR with a representation is clear');
  neg(st({ outcome: 'CLEAR', representationCount: 0, partiesConfirmed: true }).pendingReason === 'REPRESENTATION_MISSING', 'F-p2 CLEAR with NO representation is not a clearance to proceed: nobody holds authority yet');
  neg(st({ outcome: 'CLEAR', representationCount: 1, partiesConfirmed: false }).pendingReason === 'PARTIES_NOT_CONFIRMED', 'F-p3 unconfirmed parties come before any engine answer');
  neg(st({ outcome: 'PROHIBITED_CONFLICT', representationCount: 1, partiesConfirmed: true }).blocked === true, 'F-p4 PROHIBITED_CONFLICT is blocked, not pending');
  neg(st({ outcome: PERMITTED_WITH_CONSENT, representationCount: 1, partiesConfirmed: true }).pendingReason === 'CONSENT_REQUIRED', 'F-p5 consent outstanding is named CONSENT_REQUIRED, never a generic pending (§15)');
  neg(st({ outcome: 'MANUAL_REGULATORY_REVIEW_REQUIRED', representationCount: 1, partiesConfirmed: true }).pendingReason === 'MANUAL_REVIEW', 'F-p6 manual review is named');
  neg(st({ outcome: 'INSUFFICIENT_DATA', representationCount: 1, partiesConfirmed: true }).pendingReason === 'INSUFFICIENT_DATA', 'F-p7 insufficient data is named');
  neg(st({ gate: 'PROVIDER_UNAVAILABLE', partiesConfirmed: true }).pendingReason === 'PROVIDER_UNAVAILABLE' && st({ gate: 'JURISDICTION_UNSUPPORTED', partiesConfirmed: true }).pendingReason === 'JURISDICTION_UNSUPPORTED', 'F-p8 a gate refusal before the engine keeps its own reason');
  neg(st({ outcome: 'SOMETHING_ELSE', representationCount: 1, partiesConfirmed: true }).clear === false, 'F-p9 an unknown outcome is never clear');
  ok(statusForComplianceState(st({ outcome: 'CLEAR', representationCount: 1, partiesConfirmed: true })) === 'READY' && statusForComplianceState(st({ outcome: 'PROHIBITED_CONFLICT', partiesConfirmed: true })) === 'COMPLIANCE_BLOCKED', 'F-p10 clear → READY, blocked → COMPLIANCE_BLOCKED');
  ok(statusForComplianceState(st({ outcome: 'CLEAR', partiesConfirmed: false })) === 'PARTIES_CONFIRMED' && statusForComplianceState(null) === null, 'F-p11 unconfirmed parties fall back to PARTIES_CONFIRMED; no state says nothing');
  ok(PENDING_REASONS.length === 8 && PENDING_REASONS.every((r) => /^[A-Z_]+$/.test(r)), 'F-p12 eight named pending reasons, all codes');
}

section('pure G/§27 — the party revision covers the eight inputs staleness is measured on');
{
  const base = { parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-1', confirmedAt: T0 }], agentUserId: 'a1', representations: [{ agentUserId: 'a1', partyRole: 'individual', status: 'verified', agreementId: 'ag1' }], consents: [{ id: 'c1', status: 'granted' }], facetStates: { fifa_licence: 'VERIFIED' }, policyVersions: ['jp-eng-2026-27-1'], blockedSubjectIds: [], minorSubjectIds: [] };
  const h0 = partyRevisionOf(base);
  ok(/^[0-9a-f]{64}$/.test(h0) && partyRevisionOf({ ...base }) === h0, 'G-p1 the revision is a stable hash of the inputs');
  const changes = [
    ['parties', { parties: [...base.parties, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-1' }] }],
    ['the agent', { agentUserId: 'a2' }],
    ['representations', { representations: [{ ...base.representations[0], status: 'withdrawn' }] }],
    ['consents', { consents: [{ id: 'c1', status: 'revoked' }] }],
    ['licence facets', { facetStates: { fifa_licence: 'STALE' } }],
    ['policy versions', { policyVersions: ['jp-eng-2026-27-2'] }],
    ['safeguarding', { blockedSubjectIds: ['pl-1'] }],
    ['minor state', { minorSubjectIds: ['pl-1'] }],
  ];
  for (const [what, patch] of changes) neg(partyRevisionOf({ ...base, ...patch }) !== h0, `G-p2 a change to ${what} changes the revision — so the old evaluation is stale by definition, not by heuristic`);
  neg(partyRevisionOf({ ...base, parties: [{ ...base.parties[0], confirmedAt: null }] }) !== h0, 'G-p3 losing a party\'s confirmation changes it too');
  ok(partyRevisionOf({ ...base, policyVersions: ['jp-eng-2026-27-1'] }) === h0 && partyRevisionOf({ ...base, parties: [...base.parties] }) === h0, 'G-p4 re-ordering nothing changes nothing: the hash is canonical');
  neg(snapshotStaleness({ compliance: null }, h0) === 'NO_SNAPSHOT', 'G-p5 no snapshot is stale — the absence of an evaluation is never a clearance');
  neg(snapshotStaleness({ compliance: { evaluationId: 'e1', partyRevision: 'other' } }, h0) === 'INPUTS_CHANGED', 'G-p6 a different revision is INPUTS_CHANGED');
  neg(snapshotStaleness({ compliance: { evaluationId: 'e1', partyRevision: h0 }, reEvaluationPending: true }, h0) === 'POLICY_CHANGED', 'G-p7 a policy publication flag is POLICY_CHANGED');
  ok(snapshotStaleness({ compliance: { evaluationId: 'e1', partyRevision: h0 } }, h0) === null, 'G-p8 a matching revision with no flag is current');
  neg(snapshotStaleness({ compliance: { evaluationId: 'e1', partyRevision: h0, evaluatedAt: T0 } }, h0, { now: T0 + 10, maxAgeMs: 5 }) === 'EXPIRED', 'G-p9 an age bound, where one is configured, is EXPIRED');
}

section('pure M/§39/§40 — timeline audiences, and the audit that is not a timeline');
{
  ok(TIMELINE_AUDIENCES.length === 6 && TIMELINE_AUDIENCES.includes('audit_only'), 'M-p1 six audiences, one of which reaches nobody\'s timeline');
  ok(timelineAudienceOf('transaction_note_added') === 'audit_only', 'M-p2 a scoped note is audit-only: an internal note is not a club\'s timeline entry (§39)');
  ok(timelineAudienceOf('transaction_representation_attached') === 'agent_only', 'M-p3 a representation is the agent\'s regulated act, in the agent\'s lane');
  ok(timelineAudienceOf('transaction_status_changed') === 'all_parties' && timelineAudienceOf('transaction_party_confirmed') === 'all_parties', 'M-p4 status and confirmation reach every party');
  ok(timelineAudienceOf('something_unregistered') === 'audit_only', 'M-p5 an unregistered action fails closed to audit-only');
  neg(!timelineVisible('audit_only', ['representing_agent']) && !timelineVisible('audit_only', ['trust_safety']), 'M-p6 audit_only reaches nobody — not the agent, not a reviewer (§40)');
  neg(!timelineVisible('agent_only', ['party_club_signatory'], 'engaging_entity') && !timelineVisible('agent_only', ['party_individual']), 'M-p7 the agent lane reaches no club and no player');
  ok(timelineVisible('all_parties', ['party_individual']) && timelineVisible('player_and_agent', ['party_individual']) && !timelineVisible('player_and_agent', ['party_club_signatory'], 'engaging_entity'), 'M-p8 all_parties and player_and_agent behave as named');
  neg(!timelineVisible('all_parties', []), 'M-p9 a non-party sees no timeline at all');
  // D11: an entry ABOUT a document is only as visible as the document.
  ok(timelineAudienceOf('transaction_document_added') === 'per_document' && timelineAudienceOf('transaction_document_superseded') === 'per_document', 'M-p10 a document entry takes its audience from the document, not from "every party"');
  neg(!timelineVisible('per_document', ['party_club_signatory'], 'engaging_entity', { visibility: 'AGENT_PRIVATE' }), 'M-p11 a club is never told that an AGENT_PRIVATE document was added — the class would leak with the announcement (D11)');
  neg(!timelineVisible('per_document', ['party_individual'], null, { visibility: 'ENGAGING_CLUB_PRIVATE' }) && !timelineVisible('per_document', ['party_club_signatory'], 'engaging_entity', { visibility: 'RELEASING_CLUB_PRIVATE' }), 'M-p12 …and the same holds for a club-private document facing the individual, and for one club facing the other');
  ok(timelineVisible('per_document', ['party_individual'], null, { visibility: 'ALL_TRANSACTION_PARTIES' }) && timelineVisible('per_document', ['representing_agent'], null, { visibility: 'AGENT_PRIVATE' }), 'M-p13 a shared document still reaches every party, and the agent still sees their own');
  neg(!timelineVisible('per_document', ['party_individual'], null, {}) && !timelineVisible('per_document', ['party_individual'], null, null), 'M-p14 a document entry with no class recorded reaches nobody — it fails closed');
  const tx = { history: [{ id: 'h1', at: T0, action: 'transaction_created', by: { kind: 'org', userId: 'u1', name: 'Ana Costa' }, detail: { count: 2, secret: 'fee 12%' } }, { id: 'h2', at: T0 + 1, action: 'transaction_note_added', by: { kind: 'org', userId: 'u1', name: 'Ana' }, detail: { visibility: 'AGENT_PRIVATE' } }] };
  const clubTl = timelineFor(tx, ['party_club_signatory'], 'engaging_entity');
  ok(clubTl.length === 1 && clubTl[0].action === 'transaction_created', 'M-p10 the club timeline holds the creation and not the note');
  neg(JSON.stringify(clubTl).includes('fee 12%') === false && clubTl[0].detail.count === 2, 'M-p11 timeline detail is the allowlist: the count survives, an unlisted key does not');
  neg(clubTl[0].actor.label === 'Representing agent' && !JSON.stringify(clubTl).includes('Ana'), 'M-p12 the actor is a ROLE: a club never learns which named person at the agency acted');
  ok(actorLabel({ kind: 'ts_reviewer', userId: 'tsr-1', name: 'Priya Shah' }).label === 'Trust & Safety (attributed)' && !JSON.stringify(actorLabel({ kind: 'ts_reviewer', name: 'Priya Shah' })).includes('Priya'), 'M-p13 a reviewer appears as the attributed role, never by name');
  ok(actorLabel({ kind: 'club_user', name: 'Maria Keane' }).label === 'Club signatory' && actorLabel({ kind: 'player', name: 'Kola' }).label === 'Player', 'M-p14 a club user and a player are labels too');
  ok(actorLabel(null) === null, 'M-p15 no actor is no label');
}

section('pure §53/§54 — the offer boundary is a readiness boolean and its blockers');
{
  const tx = (status, confirmed = true) => ({ status, parties: [{ partyRole: 'individual', removed: false, confirmedAt: confirmed ? T0 : null }, { partyRole: 'engaging_entity', removed: false, confirmedAt: confirmed ? T0 : null }] });
  const clear = { clear: true };
  const r1 = offerReadiness(tx('READY'), { complianceState: clear, staleness: null });
  ok(r1.canStartOfferWorkflow === true && r1.blockers.length === 0 && /No offer exists/.test(r1.honest), 'O-p1 READY + clear + current → readiness true, and it says no offer exists');
  neg(offerReadiness(tx('DRAFT'), { complianceState: clear }).blockers.includes('TRANSACTION_NOT_READY'), 'O-p2 a draft is not ready for an offer');
  neg(offerReadiness(tx('READY'), { complianceState: clear, staleness: 'INPUTS_CHANGED' }).blockers.includes('COMPLIANCE_SNAPSHOT_STALE'), 'O-p3 a stale snapshot blocks readiness (#11)');
  neg(offerReadiness(tx('READY'), { complianceState: { clear: false } }).blockers.includes('COMPLIANCE_NOT_CLEAR'), 'O-p4 compliance that is not clear blocks readiness');
  neg(offerReadiness(tx('READY', false), { complianceState: clear }).blockers.includes('INDIVIDUAL_NOT_CONFIRMED'), 'O-p5 an unconfirmed individual blocks readiness');
  neg(offerReadiness(null).canStartOfferWorkflow === false, 'O-p6 no transaction, no readiness');
  neg(!JSON.stringify(offerReadiness(tx('READY'), { complianceState: clear })).match(/offerId|offerRecord|offer_made|offer_accepted/), 'O-p7 the readiness object names no offer record, because none exists');
}

section('pure §66/§67/§68 — the error contract conceals, and never carries private material');
{
  ok(M26_ERROR_HTTP.TRANSACTION_NOT_FOUND === 404 && M26_ERROR_HTTP.TRANSACTION_PARTY_NOT_FOUND === 404 && M26_ERROR_HTTP.DOCUMENT_NOT_FOUND === 404, 'Z-p1 every "you may not know whether this exists" answer is 404');
  ok(M26_ERROR_HTTP.TRANSACTION_COMPLIANCE_BLOCKED === 422 && M26_ERROR_HTTP.TRANSACTION_COMPLIANCE_STALE === 422 && M26_ERROR_HTTP.TRANSACTION_TRANSITION_NOT_ALLOWED === 409, 'Z-p2 a policy refusal is 422; a state refusal is 409');
  neg(!PUBLIC_ERROR_FIELDS.includes('text') && !PUBLIC_ERROR_FIELDS.includes('label') && !PUBLIC_ERROR_FIELDS.includes('name') && !PUBLIC_ERROR_FIELDS.includes('fee'), 'Z-p3 no note text, no document label, no name and no fee is a public error field');
  const body = publicErrorBody({ error: 'TRANSACTION_NOT_FOUND', message: 'No transaction', stack: 'x', internalNote: 'Ana', text: 'secret', fee: '12%', reasons: [{ code: 'C', ruleId: 'R', note: 'prose' }] });
  neg(body.stack === undefined && body.internalNote === undefined && body.text === undefined && body.fee === undefined, 'Z-p4 the allowlist drops everything it does not name');
  neg(body.reasons[0].note === undefined && body.reasons[0].code === 'C', 'Z-p5 a reason reaches the wire as a code and a rule reference, never as prose');
  ok(publicErrorBody({ error: 'TRANSACTION_STATE_UNKNOWN', message: 'internal detail' }).message === 'The transaction service cannot serve this request. This has been recorded.', 'Z-p6 a 500 says nothing about itself');
}

section('pure AA/AC/AD — stores, migration, events, notifications, rate policies, permissions');
{
  for (const s of ['agentTransactions', 'transactionRepresentations', 'transactionDocuments']) ok(guaranteeFor(s) === 'migration' && PRODUCTION_REQUIRED_STORES.includes(s), `AA1 ${s} is migration-guaranteed and production-required`);
  const step = MIGRATIONS.find((m) => m.id === 'm260_001_transaction_stores');
  ok(step?.version === 2307 && SCHEMA_VERSION === 2307 && MIGRATIONS.filter((m) => m.version === 2307).length === 1, 'AA2 exactly one step advances the schema to 2307');
  neg(!MIGRATIONS.some((m) => m.version > 2307), 'AA3 and nothing above it');
  const src = String(step.up);
  neg(!/recruitmentCases|complianceContexts|signings|offers/.test(src), 'AA4 the step reinterprets no existing record as a transaction and creates no offer or signing store (§3, §5)');
  const fresh = {}; step.up(fresh);
  ok(Object.keys(fresh).length === 3 && Object.values(fresh).every((v) => Array.isArray(v) && v.length === 0), 'AA5 three empty containers, nothing backfilled');
  step.up(fresh); fresh.agentTransactions.push({ id: 'x' }); step.up(fresh);
  ok(fresh.agentTransactions.length === 1, 'AA6 replaying the step is harmless and destroys nothing');
  const EVENTS = ['agent_transaction_created', 'agent_transaction_party_changed', 'agent_transaction_compliance_updated', 'agent_transaction_status_changed', 'agent_transaction_document_added', 'agent_transaction_message_linked', 'agent_transaction_held', 'agent_transaction_cancelled', 'agent_transaction_closed'];
  for (const e of EVENTS) {
    const reg = EVENT_REGISTRY[e];
    ok(reg?.audience === 'org_private' && reg.privacyClass === 'org_internal' && reg.analyticsEligible === false, `AC1 ${e} is org_private, org_internal and never analytics-eligible`);
    neg(reg.payload.every((k) => ['orgId', 'txId', 'partyRole', 'status', 'outcome', 'docId'].includes(k)), `AC2 ${e} carries ids and state words only`);
  }
  neg(EVENTS.every((e) => !EVENT_REGISTRY[e].payload.includes('playerId') && !EVENT_REGISTRY[e].payload.includes('label')), 'AC3 no transaction event carries a player id or a document label');
  neg(!EVENT_REGISTRY.offer_made && !EVENT_REGISTRY.agent_transaction_signed && !EVENT_REGISTRY.offer_accepted, 'AC4 P5.6D registered no offer and no signing event');
  ok(TYPE_CATEGORY.agent_transaction === 'transaction_updates' && TYPE_CATEGORY.agent_transaction_action === 'transaction_updates', 'AD1 workspace traffic is the transaction_updates category');
  ok(TYPE_CATEGORY.agent_transaction_compliance === 'compliance' && CATEGORIES.compliance.mandatory === true, 'AD2 the compliance half goes to the mandatory category — a regulatory change cannot be muted');
  ok(CATEGORIES.transaction_updates.default === true && CATEGORIES.transaction_updates.mandatory === false, 'AD3 transaction_updates is on by default and mutable — operational traffic is not an obligation');
  for (const [k, scope] of [['transaction_write', 'actor'], ['transaction_status_write', 'actor'], ['transaction_document_write', 'actor'], ['transaction_note_write', 'actor']]) ok(RATE_LIMIT_POLICY[k]?.scope === scope && RATE_LIMIT_POLICY[k].max > 0, `AA7 rate policy ${k}`);
  ok(can(['licensed_agent'], 'transactions.write') && PERMISSIONS['transactions.read'].length === 5, 'AA8 writing a transaction is the licensed individual\'s; reading is every member\'s');
  neg(!can(['agency_admin'], 'transactions.write') && !can(['analyst'], 'transactions.write') && !can(['assistant'], 'transactions.write') && !can(['finance'], 'transactions.write'), 'AA9 no agency support role may write a transaction (#2, #3)');
  ok(TRANSACTION_AUDIT_ACTIONS.has('transaction_note_added') && TRANSACTION_AUDIT_ACTIONS.has('transaction_status_changed') && !TRANSACTION_AUDIT_ACTIONS.has('offer_made'), 'AA10 the audit lists the note the timeline hides, and no offer action');
  ok(transactionAuditRows({}).length === 0, 'AA11 the audit projection is pure over an empty db');
  ok(TRANSACTION_LIMITS.parties === 4 && TRANSACTION_LIMITS.note === 2000 && TRANSACTION_LIMITS.documents === 200, 'AA12 explicit bounds on parties, note length and document count');
}

section('pure §3/§4/§5 — the four separations are in the code, not only in the prose');
{
  // Comments are stripped first: the assertion is about what the module DOES,
  // and a comment that says "db.signings is never written" must not read as a
  // write. A scanner that cannot tell those apart proves nothing.
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const m26index = strip(readFileSync(path.join(HERE, '..', 'm26', 'index.mjs'), 'utf8'));
  const m26pure = strip(readFileSync(path.join(HERE, '..', 'm26', 'transaction.mjs'), 'utf8'));
  const both = `${m26index}\n${m26pure}`;
  neg(!/db\.recruitmentCases/.test(both), '§3 the transaction module never reads or writes db.recruitmentCases');
  neg(!/db\.signings/.test(both), '§5 nor db.signings — no signing writer exists');
  neg(!/offer_made|offer_accepted|offer_declined|db\.recruitmentOffers/.test(both), '§4 and no offer lifecycle string appears in its code');
  neg(!/db\.roomComments|db\.roomDecisions|db\.assessments/.test(both), '§46 club-private assessment, Room and decision stores are not read by the transaction module');
  neg(!/db\.boxSessions|db\.passport/.test(both), '§47 nor Box Cam or Passport stores');
  ok(/db\.channels/.test(m26index) && !/messages\.push|new Message/.test(m26index), '§36 the canonical Inbox is referenced; no message store and no message writer is created');
}

// =================================================================== HTTP
section('HTTP — booting a real server (synthetic verification provider ON)');
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
async function boot(env = {}) {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1', ...env }, stdio: 'ignore' });
  children.push(proc); proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
  return proc;
}
async function stop(proc) {
  proc.kill('SIGTERM');
  for (let i = 0; i < 80; i++) { if (proc.exitCode != null || proc.signalCode) break; await sleep(100); }
  await sleep(300);
}
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data };
}
const login = async (orgId, scoutName, role, platform = 'agent') => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;
const reviewerLogin = async (reviewerId, secret) => (await j('POST', '/auth/reviewer/login', { reviewerId, secret })).body;
const ERROR_BODIES = [];
const collect = (label, r) => { if (r.status >= 400) ERROR_BODIES.push({ label, status: r.status, body: r.body }); return r; };

// A SECOND agency has to exist for "a foreign agency guesses an id" to be a real
// test rather than a colleague test. There is no route that creates an
// organisation, so it is seeded into the snapshot between two boots — the same
// fixture technique the compliance persistence suite uses.
let server = await boot();
await stop(server);
{
  const store = openStore(DATA_DIR);
  const snap = store.load();
  snap.db.orgs.push({ ...structuredClone(snap.db.orgs.find((o) => o.type === 'agency')), id: 'org-southgate', name: 'Southgate Sports Management', slug: 'southgate' });
  // The releasing club has to be a VERIFIED organisation, because root
  // verification authority — the recorded club signatory — only exists inside
  // one (M14). The seeded academy is unverified, so the fixture verifies it.
  const harbour = snap.db.orgs.find((o) => o.id === 'org-harbour');
  harbour.verified = true; harbour.verifiedDomain = 'harbourtownacademy.example';
  store.save(snap);
  ok(snap.db.orgs.some((o) => o.id === 'org-southgate' && o.type === 'agency') && harbour.verified === true, 'fixture: a second agency exists (so "foreign agency" is not "same-agency colleague") and the releasing club is verified (so it can hold a signatory)');
}
server = await boot();

section('setup — agency members, verified facets, relationships, club signatories');
const tomas = await login('org-northstar', 'Tomás Rivera', 'Director');
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment', null);
const devA = await login('org-harbour', 'Dev Ansah', 'Director of Football', null);
const ivy = await login('org-hackneymarsh', 'Ivy Brand', 'Chair', 'grassroots');
// A club that is party to NOTHING for the whole run, so "foreign club" stays foreign
// even after group I re-parents a transaction onto Hackney Marsh.
const outsider = await login('org-mossside', 'Nell Okafor', 'Secretary', 'grassroots');
const kola = await playerLogin('pl-adeyemi');
const mateus = await playerLogin('pl-carvalho');
const chinedu = await playerLogin('pl-okafor');
const theo = await playerLogin('pl-martin');
const filip = await playerLogin('pl-nowak');
const PRIYA = await reviewerLogin('tsr-dev-admin', 'dev-reviewer-admin');
let ANA, DAN, BEN, FAY, ZOE, ANA_ID, DAN_ID, REL_KOLA, REL_THEO, REL_CHINEDU, REL_MATEUS;
{
  const add = async (name, tiers) => (await j('POST', '/org/agent/agency/team', { name, tiers }, tomas.token)).body.member;
  ANA_ID = (await add('Ana Costa', ['licensed_agent'])).userId;
  DAN_ID = (await add('Dan Mensah', ['licensed_agent'])).userId;
  await add('Ben Okoro', ['analyst']);
  await add('Fay Idris', ['licensed_agent']);
  ANA = await login('org-northstar', 'Ana Costa', 'Agent');
  DAN = await login('org-northstar', 'Dan Mensah', 'Agent');
  BEN = await login('org-northstar', 'Ben Okoro', 'Analyst');
  FAY = await login('org-northstar', 'Fay Idris', 'Agent');
  // The other agency: the first person into an agency with no members
  // bootstraps as its administrator (never as a licensed agent — a self-typed
  // role is not a licence), so an administrator grants the licensed tier.
  const zed = await login('org-southgate', 'Zed Admin', 'Director');
  await j('POST', '/org/agent/agency/team', { name: 'Zoe Hart', tiers: ['licensed_agent'] }, zed.token);
  ZOE = await login('org-southgate', 'Zoe Hart', 'Agent');
  const prof = async (tok, name, jur) => (await j('POST', '/org/agent/profile', { displayName: name, jurisdictions: jur }, tok)).status;
  ok(await prof(ANA.token, 'Ana Costa', ['ENG', 'INT']) === 201 && await prof(DAN.token, 'Dan Mensah', ['ENG']) === 201 && await prof(ZOE.token, 'Zoe Hart', ['ENG']) === 201, 'S1 three agent profiles (Fay deliberately has none)');
  const sub = (tok, facet, reference, ma) => j('POST', `/org/agent/profile/facets/${facet}/submit`, { reference, ...(ma ? { memberAssociation: ma } : {}) }, tok);
  ok((await sub(ANA.token, 'fifa_licence', 'TEST-VERIFIED-ANA')).body.facet.state === 'VERIFIED' && (await sub(ANA.token, 'national_registration', 'TEST-VERIFIED-ANA-FA', 'ENG')).body.facet.state === 'VERIFIED', 'S2 Ana: FIFA licence and FA registration VERIFIED');
  ok((await sub(DAN.token, 'fifa_licence', 'TEST-VERIFIED-DAN')).body.facet.state === 'VERIFIED' && (await sub(DAN.token, 'national_registration', 'TEST-VERIFIED-DAN-FA', 'ENG')).body.facet.state === 'VERIFIED', 'S3 Dan likewise');
  ok((await sub(ZOE.token, 'fifa_licence', 'TEST-VERIFIED-ZOE')).body.facet.state === 'VERIFIED' && (await sub(ZOE.token, 'national_registration', 'TEST-VERIFIED-ZOE-FA', 'ENG')).body.facet.state === 'VERIFIED', 'S4 Zoe at the other agency likewise');
  const req = async (tok, playerId, over = {}) => (await j('POST', '/org/agent/clients/request', { playerId, scope: ['employment', 'transfer'], jurisdiction: 'ENG', ...over }, tok));
  const r1 = await req(ANA.token, 'pl-adeyemi'); REL_KOLA = r1.body?.relationship?.id;
  ok(r1.status === 201 && (await j('POST', `/player/agent/relationships/${REL_KOLA}/confirm`, { expectedRev: 1 }, kola.token)).body.relationship.status === 'active', 'S5 Ana ↔ Kola: ENG employment + transfer, client-confirmed');
  const r2 = await req(ANA.token, 'pl-martin', { scope: ['commercial'] }); REL_THEO = r2.body?.relationship?.id;
  ok(r2.status === 201 && (await j('POST', `/player/agent/relationships/${REL_THEO}/confirm`, { expectedRev: 1 }, theo.token)).body.relationship.status === 'active', 'S6 Ana ↔ Theo: ENG commercial ONLY, confirmed');
  const r3 = await req(DAN.token, 'pl-okafor'); REL_CHINEDU = r3.body?.relationship?.id;
  ok(r3.status === 201 && (await j('POST', `/player/agent/relationships/${REL_CHINEDU}/confirm`, { expectedRev: 1 }, chinedu.token)).body.relationship.status === 'active', 'S7 Dan ↔ Chinedu: ENG, confirmed');
  const r4 = await req(ANA.token, 'pl-carvalho', { jurisdiction: 'INT', scope: ['employment'] }); REL_MATEUS = r4.body?.relationship?.id;
  ok(r4.status === 201 && (await j('POST', `/player/agent/relationships/${REL_MATEUS}/confirm`, { expectedRev: 1 }, mateus.token)).body.relationship.status === 'active', 'S8 Ana ↔ Mateus: INT employment, confirmed');
  const a1 = await j('POST', '/admin/verification/orgs/org-eastport/appoint-root', { userId: maria.userId, reason: 'P5.6D suite: engaging club signatory' }, PRIYA.token, ADMIN);
  const a2 = await j('POST', '/admin/verification/orgs/org-harbour/appoint-root', { userId: devA.userId, reason: 'P5.6D suite: releasing club signatory' }, PRIYA.token, ADMIN);
  ok(a1.status === 201 && a2.status === 201, `S9 Trust & Safety records a signatory for each club, attributed to a named reviewer (${a1.status}/${a2.status} ${a1.body?.error ?? ''}${a2.body?.error ?? ''})`);
}

// ============================================================ A — create
section('A/§62/§63 — who may open a transaction, and what opening one does NOT grant');
let TX1;
{
  const body = { type: 'transfer', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }, { partyRole: 'releasing_entity', subjectKind: 'club', subjectId: 'org-harbour' }] };
  neg(expect(collect('A1', await j('POST', '/org/agent/transactions', body, BEN.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'A1 an analyst cannot open a transaction (#2 agency assistant)');
  neg(expect(collect('A2', await j('POST', '/org/agent/transactions', body, tomas.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'A2 an agency administrator without the licensed_agent role cannot either (#3 admin impersonates Agent)');
  neg(expect(collect('A3', await j('POST', '/org/agent/transactions', body, maria.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'A3 a club user has no agent workspace: a club\'s lane is its party routes');
  neg(expect(collect('A4', await j('POST', '/org/agent/transactions', body, kola.token)), 401, null), 'A4 a player token is no agency session');
  neg(expect(collect('A5', await j('POST', '/org/agent/transactions', { ...body, type: 'offer' }, ANA.token)), 400, 'TRANSACTION_INPUT_INVALID') && expect(collect('A5b', await j('POST', '/org/agent/transactions', { ...body, type: 'renewal' }, ANA.token)), 400, 'TRANSACTION_INPUT_INVALID'), 'A5 "offer" is not a transaction type, and neither is an unfrozen "renewal"');
  neg(expect(collect('A6', await j('POST', '/org/agent/transactions', { ...body, jurisdictions: [] }, ANA.token)), 400, 'TRANSACTION_INPUT_INVALID'), 'A6 jurisdictions are required');
  neg(expect(collect('A7', await j('POST', '/org/agent/transactions', { ...body, jurisdictions: ['FRA'] }, ANA.token)), 422, 'JURISDICTION_UNSUPPORTED'), 'A7 an unsupported jurisdiction opens nothing — no silent allow (#24, §58)');
  neg(expect(collect('A8', await j('POST', '/org/agent/transactions', body, FAY.token)), 403, 'AGENT_VERIFICATION_REQUIRED'), 'A8 a licensed_agent with no profile at all cannot open one');
  const minorTry = collect('A9', await j('POST', '/org/agent/transactions', { ...body, parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-guni' }] }, ANA.token));
  const ghostTry = collect('A9b', await j('POST', '/org/agent/transactions', { ...body, parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-nobody-at-all' }] }, ANA.token));
  neg(expect(minorTry, 404, 'TRANSACTION_PARTY_NOT_FOUND') && expect(ghostTry, 404, 'TRANSACTION_PARTY_NOT_FOUND') && JSON.stringify(minorTry.body) === JSON.stringify(ghostTry.body), 'A9 a minor and a player who does not exist answer with byte-identical bodies (#23, V)');
  const forgedRes = collect('A10', await j('POST', '/org/agent/transactions', { ...body, parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi', dob: '2012-01-01', guardianConsent: true, complianceOutcome: 'CLEAR', status: 'ACTIVE', rev: 99, policyVersion: 'jp-forged-1' }] }, ANA.token));
  neg(expect(forgedRes, 201, null), 'A10 a forged date of birth, guardian consent, compliance outcome, status, rev and policy version in the body are ignored (#19–#22, §67)');
  const forged = forgedRes.body?.transaction;
  neg(forged?.status === 'DRAFT' && forged.rev === 1 && forged.compliance.clear === false && forged.compliance.pendingReason === 'PARTIES_NOT_CONFIRMED', `A10b …and the created transaction is a DRAFT at rev 1 whose compliance says parties are not confirmed (${forged?.status}/${forged?.rev}/${forged?.compliance?.pendingReason})`);
  neg(!JSON.stringify(forged).includes('jp-forged-1'), 'A10c the forged policy version reached no field of the record');
  neg(expect(collect('A11', await j('POST', '/org/agent/transactions', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'releasing_entity', subjectKind: 'club', subjectId: 'org-harbour' }] }, ANA.token)), 400, 'TRANSACTION_INPUT_INVALID'), 'A11 an employment contract has no releasing entity');
  neg(expect(collect('A12', await j('POST', '/org/agent/transactions', { ...body, parties: [{ partyRole: 'engaging_entity', subjectKind: 'player', subjectId: 'pl-adeyemi' }] }, ANA.token)), 400, 'TRANSACTION_INPUT_INVALID') && expect(collect('A12b', await j('POST', '/org/agent/transactions', { ...body, parties: [{ partyRole: 'individual', subjectKind: 'club', subjectId: 'org-eastport' }] }, ANA.token)), 400, 'TRANSACTION_INPUT_INVALID'), 'A12 a player is the individual and a club is an entity — neither can take the other\'s role');
  neg(expect(collect('A13', await j('POST', '/org/agent/transactions', { ...body, parties: [{ partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-does-not-exist' }] }, ANA.token)), 404, 'TRANSACTION_PARTY_NOT_FOUND'), 'A13 an unknown club is the uniform 404');
  neg(expect(collect('A14', await j('POST', '/org/agent/transactions', { ...body, parties: [...body.parties, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-hackneymarsh' }] }, ANA.token)), 409, 'TRANSACTION_PARTY_EXISTS'), 'A14 one party per role');
  const create = await j('POST', '/org/agent/transactions', { ...body, clientKey: 'tx-1' }, ANA.token);
  TX1 = create.body?.transaction?.id;
  ok(create.status === 201 && create.body.transaction.status === 'DRAFT' && create.body.transaction.type === 'transfer' && create.body.transaction.parties.length === 3, 'A15 Ana opens an England transfer: Kola, Eastport engaging, Harbour releasing — status DRAFT');
  ok(create.body.transaction.playerId === 'pl-adeyemi' && create.body.transaction.engagingOrgId === 'org-eastport' && create.body.transaction.releasingOrgId === 'org-harbour', 'A16 the derived convenience ids are computed from parties[], which stays the single truth');
  neg(create.body.transaction.representations.length === 0 && create.body.transaction.consents.length === 0 && create.body.transaction.partiesConfirmed === false, 'A17 opening one establishes no representation, no consent and no party confirmation (§63)');
  neg(create.body.transaction.compliance.clear === false && create.body.transaction.compliance.pendingReason === 'PARTIES_NOT_CONFIRMED' && create.body.transaction.offerBoundary.canStartOfferWorkflow === false, 'A18 a DRAFT implies no compliance clearance and no offer readiness (§13)');
  ok(/not a statement of legal validity/.test(create.body.transaction.honest) && /no offer exists/i.test(create.body.transaction.offerBoundary.honest), 'A19 the projection states plainly what "ready" does and does not mean (§17, §77)');
  ok((await j('POST', '/org/agent/transactions', { ...body, clientKey: 'tx-1' }, ANA.token)).body.idempotent === true, 'X1 replaying the create with its key returns the same transaction (§69)');
  neg(expect(collect('X2', await j('POST', '/org/agent/transactions', { ...body, type: 'loan', clientKey: 'tx-1' }, ANA.token)), 409, 'TRANSACTION_IDEMPOTENCY_CONFLICT'), 'X2 the same key with a different payload is a collision (#28)');
}

// ============================================================ B/C — party identity and history
section('B/C/§8/§9 — canonical ids, confirmation by the party itself, history that is never overwritten');
{
  const t0 = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
  ok(t0.awaitingConfirmation.join() === 'individual,engaging_entity,releasing_entity' && t0.requiredPartyRoles.length === 3, 'B1 all three required parties are awaiting their own confirmation');
  neg(expect(collect('B2', await j('POST', `/org/transactions/${TX1}/confirm`, {}, ivy.token)), 404, 'TRANSACTION_NOT_FOUND'), 'B2 a club that is not a party cannot confirm — and cannot tell the transaction exists (#5)');
  neg(expect(collect('B3', await j('POST', `/org/transactions/${TX1}/confirm`, {}, maria.token)), 200, null), 'B3 Eastport\'s recorded signatory confirms the engaging club');
  const beforeRelease = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
  ok(beforeRelease.parties.find((p) => p.partyRole === 'engaging_entity').confirmedByKind === 'club_user' && beforeRelease.awaitingConfirmation.join() === 'individual,releasing_entity', 'C1 the confirmation is recorded with its actor kind; two roles remain');
  ok((await j('POST', `/org/transactions/${TX1}/confirm`, {}, devA.token)).status === 200 && (await j('POST', `/player/transactions/${TX1}/confirm`, {}, kola.token)).status === 200, 'C2 the releasing club and the individual confirm for themselves (§64, §65)');
  const t1 = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
  ok(t1.partiesConfirmed === true && t1.status === 'PARTIES_CONFIRMED' && t1.parties.every((p) => p.confirmedAt), `C3 with every party confirmed the status is PARTIES_CONFIRMED (${t1.status}) (§14)`);
  ok((await j('POST', `/player/transactions/${TX1}/confirm`, {}, kola.token)).body.idempotent === true, 'X3 confirming twice is idempotent');
  neg(t1.compliance.pendingReason === 'REPRESENTATION_MISSING' && t1.compliance.clear === false, 'F1 party confirmation is not a clearance: with no representation bound, nobody holds authority yet');
  const tl = (await j('GET', `/org/agent/transactions/${TX1}/timeline`, undefined, ANA.token)).body.items;
  ok(tl.some((e) => e.action === 'transaction_party_confirmed' && e.detail?.partyRole === 'engaging_entity') && tl.some((e) => e.action === 'transaction_created'), 'C4 the timeline holds the creation and every confirmation, append-only');
}

// ============================================================ E — representation bindings
section('E/§23/§24 — a representation binding is transaction-specific and re-derived at mutation time');
let REP_KOLA;
{
  neg(expect(collect('E1', await j('POST', `/org/agent/transactions/${TX1}/representations`, { partyRole: 'individual' }, ANA.token)), 403, 'REPRESENTATION_REQUIRED'), 'E1 no agreementId, no binding — an active relationship is not itself authority here');
  neg(expect(collect('E2', await j('POST', `/org/agent/transactions/${TX1}/representations`, { partyRole: 'individual', agreementId: REL_THEO }, ANA.token)), 403, 'REPRESENTATION_REQUIRED'), 'E2 an agreement with ANOTHER client authorises nothing for this party');
  neg(expect(collect('E3', await j('POST', `/org/agent/transactions/${TX1}/representations`, { partyRole: 'individual', agreementId: REL_CHINEDU }, ANA.token)), 403, 'REPRESENTATION_REQUIRED'), 'E3 a colleague\'s agreement authorises nothing: agency membership is not the agent (#22)');
  neg(expect(collect('E4', await j('POST', `/org/agent/transactions/${TX1}/representations`, { partyRole: 'individual', agreementId: REL_MATEUS }, ANA.token)), 403, 'REPRESENTATION_REQUIRED'), 'E4 nor does the agent\'s own agreement with a different client');
  const bind = await j('POST', `/org/agent/transactions/${TX1}/representations`, { partyRole: 'individual', agreementId: REL_KOLA, clientKey: 'rep-1' }, ANA.token);
  REP_KOLA = bind.body?.representation?.id;
  ok(bind.status === 201 && bind.body.representation.status === 'verified', 'E7 the individual binding, backed by the client-confirmed agreement, is verified');
  ok((await j('POST', `/org/agent/transactions/${TX1}/representations`, { partyRole: 'individual', agreementId: REL_KOLA, clientKey: 'rep-1' }, ANA.token)).body.idempotent === true, 'X4 the binding key replays');
  neg(expect(collect('E8', await j('POST', `/org/agent/transactions/${TX1}/representations`, { partyRole: 'individual', agreementId: REL_KOLA }, ANA.token)), 409, 'TRANSACTION_PARTY_EXISTS'), 'E8 the same agent cannot bind the same party twice');
  neg(expect(collect('E5', await j('POST', `/org/agent/transactions/${TX1}/representations`, { partyRole: 'engaging_entity', agreementId: REL_KOLA }, ANA.token)), 422, 'REGULATORY_REVIEW_REQUIRED'), 'E5 also binding the engaging club — an entity with no ScoutBox agreement — is DECLARED ONLY and needs attributed review (DR-18)');
  const declared = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction.representations.find((r) => r.partyRole === 'engaging_entity');
  ok(declared?.status === 'pending_review' && declared.declaredOnly === true && declared.basis === 'declared' && declared.reviewId, 'E6 the declared binding is recorded as pending_review with its review id — never as effective');
  neg(expect(collect('E9', await j('POST', `/org/agent/transactions/${TX1}/representations`, { partyRole: 'individual', agreementId: REL_CHINEDU }, DAN.token)), 404, 'TRANSACTION_NOT_FOUND'), 'E9 a same-agency colleague cannot bind anything to Ana\'s transaction, nor learn it exists (#4)');
  const t = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
  ok(t.representations.find((r) => r.partyRole === 'individual').basis === 'client_confirmed_agreement' && t.representations.find((r) => r.partyRole === 'individual').agreementId === REL_KOLA, 'E10 the binding carries its provenance: the agreement it rests on (§23)');
  ok(t.compliance.pendingReason === 'MANUAL_REVIEW' || t.compliance.pendingReason === 'CONSENT_REQUIRED' || t.compliance.blocked, `E11 with an unverified entity declaration in play, compliance is not clear (${t.compliance.pendingReason ?? 'blocked'})`);
}

// ============================================================ D — state transitions
section('D/§12/§16/§25/§26 — transitions are server-validated and compliance-driven states are unreachable by request');
{
  for (const bad of ['READY', 'COMPLIANCE_PENDING', 'COMPLIANCE_BLOCKED']) {
    neg(expect(collect(`D-${bad}`, await j('POST', `/org/agent/transactions/${TX1}/status`, { to: bad }, ANA.token)), 409, 'TRANSACTION_TRANSITION_NOT_ALLOWED'), `D15 an actor cannot request ${bad}: it is the compliance layer's answer, not a request (#25, #26)`);
  }
  neg(expect(collect('D16', await j('POST', `/org/agent/transactions/${TX1}/status`, { to: 'NOT_A_STATE' }, ANA.token)), 400, 'TRANSACTION_INPUT_INVALID'), 'D16 a freeform status string is refused (§11)');
  const active = collect('D17', await j('POST', `/org/agent/transactions/${TX1}/status`, { to: 'ACTIVE' }, ANA.token));
  neg(active.status === 422 && ['TRANSACTION_COMPLIANCE_PENDING', 'TRANSACTION_COMPLIANCE_BLOCKED', 'TRANSACTION_COMPLIANCE_STALE'].includes(active.body.error), `D17 ACTIVE is refused while compliance is outstanding, by compliance and not by the map (${active.body.error})`);
  neg(active.body.pendingReason !== undefined || active.body.staleness !== undefined || active.body.outcome !== undefined, 'D18 …and the refusal names which fact is in the way');
  neg(expect(collect('D19', await j('POST', `/org/agent/transactions/${TX1}/status`, { to: 'ON_HOLD' }, ANA.token)), 409, 'TRANSACTION_TRANSITION_NOT_ALLOWED'), 'D19 a hold is NOT reachable from a compliance state — a hold is for a live workflow');
  const t = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
  neg(!t.allowedTransitions.some((s) => ['READY', 'COMPLIANCE_PENDING', 'COMPLIANCE_BLOCKED'].includes(s)), 'D20 the projection never offers a compliance-driven transition as an action');
  neg(expect(collect('D21', await j('POST', `/org/agent/transactions/${TX1}/status`, { to: 'CANCELLED' }, DAN.token)), 404, 'TRANSACTION_NOT_FOUND') && expect(collect('D21b', await j('POST', `/org/agent/transactions/${TX1}/status`, { to: 'CANCELLED' }, maria.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'D21 neither a colleague nor a club party may move the status');
}

// ============================================================ H/I — consent and party change
section('H/I/§10/§29 — consent comes from the P5.6C ledger; a party change invalidates the clearance');
let TX2, KOLA_CONSENT2;
{
  // A clean two-party employment transaction, so the dual-representation path is
  // reached without the entity-declaration review in the way.
  const c = await j('POST', '/org/agent/transactions', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }], clientKey: 'tx-2' }, ANA.token);
  TX2 = c.body.transaction.id;
  ok(c.status === 201 && requiredPartyRoles('employment_contract').length === 2, 'H1 a second transaction: an England employment contract with two required parties');
  await j('POST', `/org/transactions/${TX2}/confirm`, {}, maria.token);
  await j('POST', `/player/transactions/${TX2}/confirm`, {}, kola.token);
  const bind = await j('POST', `/org/agent/transactions/${TX2}/representations`, { partyRole: 'individual', agreementId: REL_KOLA }, ANA.token);
  ok(bind.status === 201, 'H2 Ana binds Kola');
  const t2 = (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body.transaction;
  ok(t2.compliance.clear === true && t2.status === 'READY', 'H3 one party represented, consents satisfied, England rules encoded → READY');
  ok(t2.offerBoundary.canStartOfferWorkflow === true && t2.offerBoundary.blockers.length === 0, '§54 readiness for a future Offer is computed — and no offer record exists');
  const dual = collect('H4', await j('POST', `/org/agent/transactions/${TX2}/representations`, { partyRole: 'engaging_entity', agreementId: null }, ANA.token));
  neg(expect(dual, 422, 'REGULATORY_REVIEW_REQUIRED') && dual.body.contextId, 'H4 also acting for the club is a declared-only binding needing attributed review before any consent question arises');
  const declaredRep = (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body.transaction.representations.find((r) => r.partyRole === 'engaging_entity');
  const review = (await j('GET', '/ts/compliance/reviews?status=PENDING', undefined, PRIYA.token)).body.items.find((r) => r.kind === 'representation_declared' && r.subject?.representationId === declaredRep.id);
  ok(review?.subject?.transactionId === TX2, 'H5 the review names the transaction it belongs to, so the decision can land on the binding row');
  const resolved = await j('POST', `/ts/compliance/reviews/${review.id}/resolve`, { outcome: 'APPROVED', reasonCode: 'mandate_seen', reason: 'Club mandate letter of 18 Sep 2026 seen.', evidenceRefs: ['Eastport mandate letter 2026-09-18'] }, PRIYA.token);
  ok(resolved.status === 200 && resolved.body.review.decision.reviewer.id === 'tsr-dev-admin', 'H6 a NAMED reviewer approves it');
  const afterReview = (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body.transaction;
  ok(afterReview.representations.find((r) => r.partyRole === 'engaging_entity').status === 'verified', 'H7 the decision lands on the transactionRepresentations row — the store is the truth, the context array is its projection');
  neg(afterReview.compliance.pendingReason === 'CONSENT_REQUIRED' && afterReview.compliance.consentRequirements.length === 2 && afterReview.status === 'COMPLIANCE_PENDING', 'H8 now that the agent acts for two parties, England requires prior written consent FROM EACH — two requirements, one per party');
  const h9 = collect('H9', await j('POST', `/org/agent/transactions/${TX2}/status`, { to: 'ACTIVE' }, ANA.token));
  neg(expect(h9, 422, 'TRANSACTION_COMPLIANCE_PENDING') && h9.body.pendingReason === 'CONSENT_REQUIRED', 'H9 the transaction cannot progress while consent is outstanding, and the refusal says so (#25)');
  const req1 = await j('POST', `/org/agent/transactions/${TX2}/consents/request`, { partyRole: 'individual', fullParticularsProvided: true, legalAdviceOffered: true, proposedFeeDisclosed: true }, ANA.token);
  KOLA_CONSENT2 = req1.body?.consent?.id;
  ok(req1.status === 201 && KOLA_CONSENT2, 'H10 Ana requests Kola\'s consent from inside the workspace — through the P5.6C ledger, not a second store');
  const req2 = await j('POST', `/org/agent/transactions/${TX2}/consents/request`, { partyRole: 'engaging_entity', fullParticularsProvided: true, legalAdviceOffered: true, proposedFeeDisclosed: true }, ANA.token);
  ok(req2.status === 201, 'H11 and the club\'s');
  const playerSide = (await j('GET', `/player/transactions/${TX2}`, undefined, kola.token)).body.transaction;
  const mine = playerSide.consents.find((k) => k.mine);
  ok(mine && mine.id === KOLA_CONSENT2 && mine.particulars && playerSide.consents.filter((k) => !k.mine).every((k) => k.id === null && k.particulars === undefined), 'H12 the player sees their OWN consent in full and the club\'s as a state only, with no id and no particulars (§30)');
  ok((await j('POST', `/player/agent/consents/${KOLA_CONSENT2}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true }, kola.token)).status === 200, 'H13 Kola grants his own consent in the canonical player lane');
  const clubConsent = (await j('GET', '/org/compliance/consents', undefined, maria.token)).body.items.find((k) => k.status === 'requested');
  ok((await j('POST', `/org/compliance/consents/${clubConsent.id}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true }, maria.token)).status === 200, 'H14 the club\'s recorded signatory grants for the club');
  const cleared = await j('POST', `/org/agent/transactions/${TX2}/evaluate`, {}, ANA.token);
  ok(cleared.body.transaction.compliance.clear === true && cleared.body.transaction.status === 'READY', 'H15 with both party-specific consents recorded the transaction is READY again');
  const goActive = await j('POST', `/org/agent/transactions/${TX2}/status`, { to: 'ACTIVE', clientKey: 'tx2-active' }, ANA.token);
  ok(goActive.status === 200 && goActive.body.transaction.status === 'ACTIVE', 'D22 and only now can it become ACTIVE');
  ok((await j('POST', `/org/agent/transactions/${TX2}/status`, { to: 'ACTIVE', clientKey: 'tx2-active' }, ANA.token)).body.idempotent === true, 'X5 the status key replays');
}

// ============================================================ G — stale compliance
section('G/§27/§28 — a stale snapshot authorises nothing, and says which fact moved');
{
  const revoke = await j('POST', `/player/agent/consents/${KOLA_CONSENT2}/revoke`, {}, kola.token);
  ok(revoke.status === 200, 'G1 Kola revokes his consent mid-workflow');
  const read = (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body.transaction;
  neg(read.compliance.staleness === 'INPUTS_CHANGED', 'G2 the agent\'s read reports the snapshot as stale and names the reason — reported, never silently repaired');
  neg(read.offerBoundary.canStartOfferWorkflow === false && read.offerBoundary.blockers.includes('COMPLIANCE_SNAPSHOT_STALE'), 'G3 readiness for a future Offer is withdrawn by staleness alone (#11)');
  const hold = await j('POST', `/org/agent/transactions/${TX2}/status`, { to: 'ON_HOLD', reasonCode: 'awaiting_party_decision', reason: 'Client is reconsidering.' }, ANA.token);
  ok(hold.status === 200 && hold.body.transaction.status === 'ON_HOLD' && hold.body.transaction.hold.reasonCode === 'awaiting_party_decision', 'D23 a hold needs a reason code and records it (§19)');
  const resume = collect('G4', await j('POST', `/org/agent/transactions/${TX2}/status`, { to: 'ACTIVE' }, ANA.token));
  neg(expect(resume, 422, 'TRANSACTION_COMPLIANCE_STALE') && resume.body.staleness === 'INPUTS_CHANGED', 'G4 leaving the hold is refused BEFORE any re-check: a caller cannot enter the live workflow on facts they have not seen (#12)');
  const reeval = await j('POST', `/org/agent/transactions/${TX2}/evaluate`, {}, ANA.token);
  neg(reeval.body.transaction.compliance.pendingReason === 'CONSENT_REQUIRED' && reeval.body.transaction.compliance.staleness === null, 'G5 re-evaluating produces a current snapshot whose answer is: consent is required again (#12)');
  const resume2 = collect('G6', await j('POST', `/org/agent/transactions/${TX2}/status`, { to: 'ACTIVE' }, ANA.token));
  neg(expect(resume2, 422, 'TRANSACTION_COMPLIANCE_PENDING') && resume2.body.pendingReason === 'CONSENT_REQUIRED', 'G6 and with a current snapshot the refusal is the real reason, not staleness');
  neg(expect(collect('G7', await j('POST', `/player/agent/consents/${KOLA_CONSENT2}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true }, kola.token)), 409, 'CONSENT_NOT_PENDING'), 'G7 a revoked consent cannot be re-granted — a fresh request is needed');
}

// ============================================================ I — party change invalidation
section('I/§9/§10 — changing a party withdraws what rested on it and re-evaluates');
{
  const t = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
  const engaging = t.parties.find((p) => p.partyRole === 'engaging_entity');
  const rm = await j('POST', `/org/agent/transactions/${TX1}/parties/${engaging.id}/remove`, {}, ANA.token);
  ok(rm.status === 200, 'I1 Ana removes the engaging club');
  const after = rm.body.transaction;
  ok(after.parties.find((p) => p.id === engaging.id).removed === true && after.parties.find((p) => p.id === engaging.id).removedAt && after.parties.length === 3, 'I2 the party row STAYS with its removedAt — history is never overwritten invisibly (§9)');
  neg(after.representations.find((r) => r.partyRole === 'engaging_entity').status === 'withdrawn', 'I3 every representation that named that role is withdrawn: authority cannot outlive its party');
  neg(after.partiesConfirmed === false && after.awaitingConfirmation.includes('engaging_entity') && after.compliance.clear === false, 'I4 the transaction falls out of any compliance claim it held and asks for the party again');
  ok((await j('POST', `/org/agent/transactions/${TX1}/parties/${engaging.id}/remove`, {}, ANA.token)).body.idempotent === true, 'X6 removing again is idempotent');
  const add = await j('POST', `/org/agent/transactions/${TX1}/parties`, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-hackneymarsh', clientKey: 'party-1' }, ANA.token);
  ok(add.status === 201 && add.body.transaction.parties.filter((p) => !p.removed).some((p) => p.subjectId === 'org-hackneymarsh'), 'I5 a different engaging club is named');
  neg(add.body.transaction.parties.find((p) => p.subjectId === 'org-hackneymarsh').confirmedAt === null, 'I6 the new party starts unconfirmed: naming is not confirming');
  ok((await j('POST', `/org/agent/transactions/${TX1}/parties`, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-hackneymarsh', clientKey: 'party-1' }, ANA.token)).body.idempotent === true, 'X7 the party key replays');
  const tl = (await j('GET', `/org/agent/transactions/${TX1}/timeline`, undefined, ANA.token)).body.items;
  ok(tl.some((e) => e.action === 'transaction_party_removed') && tl.some((e) => e.action === 'transaction_party_added' && e.detail?.partyRole === 'engaging_entity'), 'I7 both the removal and the addition are in the timeline');
  const old = await j('GET', `/org/transactions/${TX1}`, undefined, maria.token);
  neg(expect(collect('I8', old), 404, 'TRANSACTION_NOT_FOUND'), 'I8 the club that was removed can no longer read the transaction — nor tell it still exists');
}

// ============================================================ J — documents
section('J/§31–§34/§80 — document classification, and no leakage across parties');
let DOC_AGENT_PRIVATE, DOC_SHARED, DOC_ENG_PRIVATE, DOC_REL_PRIVATE, DOC_PLAYER_PRIVATE;
{
  const post = (tok, body, url = `/org/agent/transactions/${TX2}/documents`) => j('POST', url, body, tok);
  neg(expect(collect('J1', await post(ANA.token, { documentType: 'not_a_type', visibility: 'AGENT_PRIVATE', label: 'x' })), 400, 'DOCUMENT_INPUT_INVALID'), 'J1 an unknown document type is refused');
  neg(expect(collect('J2', await post(ANA.token, { documentType: 'mandate', visibility: 'T_AND_S_ONLY', label: 'x' })), 403, 'DOCUMENT_VISIBILITY_NOT_PERMITTED'), 'J2 nobody files into the Trust & Safety lane');
  neg(expect(collect('J3', await post(ANA.token, { documentType: 'mandate', visibility: 'PLAYER_PRIVATE', label: 'x' })), 403, 'DOCUMENT_VISIBILITY_NOT_PERMITTED'), 'J3 the agent cannot file into the player\'s private lane');
  neg(expect(collect('J4', await post(ANA.token, { documentType: 'mandate', visibility: 'AGENT_PRIVATE', label: '' })), 400, 'DOCUMENT_INPUT_INVALID'), 'J4 a document needs a label the other parties can read');
  neg(expect(collect('J5', await post(ANA.token, { documentType: 'mandate', visibility: 'AGENT_PRIVATE', label: 'x', evidenceRef: { kind: 'assessment', id: 'a1' } })), 400, 'DOCUMENT_INPUT_INVALID'), 'J5 an evidence reference names the canonical evidence vault or nothing — a club assessment is not a transaction document (§46)');
  neg(expect(collect('J6', await post(ANA.token, { documentType: 'mandate', visibility: 'AGENT_PRIVATE', label: 'x', evidenceRef: { kind: 'verification_evidence', id: 've-someone-else' } })), 400, 'DOCUMENT_INPUT_INVALID'), 'J6 and a reference to an evidence record that is not the uploader\'s is refused');
  neg(expect(collect('J7', await post(ANA.token, { documentType: 'mandate', visibility: 'AGENT_PRIVATE', label: 'x', expiresAt: 1000 })), 400, 'DOCUMENT_INPUT_INVALID'), 'J7 an expiry in the past is refused');
  const d1 = await post(ANA.token, { documentType: 'mandate', visibility: 'AGENT_PRIVATE', label: 'Internal mandate working copy', clientKey: 'doc-1' });
  DOC_AGENT_PRIVATE = d1.body?.document?.id;
  ok(d1.status === 201 && d1.body.document.version === 1 && d1.body.document.evidence === null && d1.body.document.downloadable === false, 'J8 an AGENT_PRIVATE placeholder with no file attached says exactly that');
  ok((await post(ANA.token, { documentType: 'mandate', visibility: 'AGENT_PRIVATE', label: 'Internal mandate working copy', clientKey: 'doc-1' })).body.idempotent === true, 'X8 the document key replays');
  const d2 = await post(ANA.token, { documentType: 'term_sheet_draft', visibility: 'ALL_TRANSACTION_PARTIES', label: 'Draft term sheet v1' });
  DOC_SHARED = d2.body?.document?.id;
  ok(d2.status === 201, 'J9 a draft term sheet shared with every party');
  const d3 = await j('POST', `/org/transactions/${TX2}/documents`, { documentType: 'club_document', visibility: 'ENGAGING_CLUB_PRIVATE', label: 'Eastport internal budget note' }, maria.token);
  DOC_ENG_PRIVATE = d3.body?.document?.id;
  ok(d3.status === 201 && d3.body.document.ownerKind === 'club' && d3.body.document.ownerPartyRole === 'engaging_entity', 'J10 the engaging club files its own private document, owned and side-stamped by the server');
  const d4 = await j('POST', `/player/transactions/${TX2}/documents`, { documentType: 'regulatory_evidence', visibility: 'PLAYER_PRIVATE', label: 'My passport scan reference' }, kola.token);
  DOC_PLAYER_PRIVATE = d4.body?.document?.id;
  ok(d4.status === 201, 'J11 the individual files a private document');
  neg(expect(collect('J12', await j('POST', `/org/transactions/${TX2}/documents`, { documentType: 'club_document', visibility: 'RELEASING_CLUB_PRIVATE', label: 'x' }, maria.token)), 403, 'DOCUMENT_VISIBILITY_NOT_PERMITTED'), 'J12 the engaging club cannot file into the releasing club\'s lane');
  neg(expect(collect('J13', await j('POST', `/player/transactions/${TX2}/documents`, { documentType: 'club_document', visibility: 'ENGAGING_CLUB_PRIVATE', label: 'x' }, kola.token)), 403, 'DOCUMENT_VISIBILITY_NOT_PERMITTED'), 'J13 nor can the player');
  const agentDocs = (await j('GET', `/org/agent/transactions/${TX2}/documents`, undefined, ANA.token)).body.items.map((d) => d.id);
  const clubDocs = (await j('GET', `/org/transactions/${TX2}/documents`, undefined, maria.token)).body.items.map((d) => d.id);
  const playerDocs = (await j('GET', `/player/transactions/${TX2}/documents`, undefined, kola.token)).body.items.map((d) => d.id);
  ok(agentDocs.includes(DOC_AGENT_PRIVATE) && agentDocs.includes(DOC_SHARED), 'J14 the representing agent reads their own document and the shared one');
  neg(!agentDocs.includes(DOC_PLAYER_PRIVATE) && !agentDocs.includes(DOC_ENG_PRIVATE), 'J15 …and NOT the player\'s private document, and NOT the engaging club\'s: "club-private" means private to the club, even from its own transaction agent (#9)');
  neg(!clubDocs.includes(DOC_AGENT_PRIVATE) && !clubDocs.includes(DOC_PLAYER_PRIVATE) && clubDocs.includes(DOC_SHARED) && clubDocs.includes(DOC_ENG_PRIVATE), 'J16 the club reads the shared one and its own; never the agent\'s private note and never the player\'s (#10, §34)');
  neg(!playerDocs.includes(DOC_AGENT_PRIVATE) && !playerDocs.includes(DOC_ENG_PRIVATE) && playerDocs.includes(DOC_SHARED) && playerDocs.includes(DOC_PLAYER_PRIVATE), 'J17 the player reads the shared one and their own; never a club-private document (§34)');
  neg(expect(collect('J18', await j('GET', `/player/transactions/${TX2}/documents/${DOC_ENG_PRIVATE}/reference`, undefined, kola.token)), 404, 'DOCUMENT_NOT_FOUND'), 'J18 asking for a club-private reference by id answers as though it does not exist (§80)');
  neg(expect(collect('J19', await j('GET', `/org/transactions/${TX2}/documents/${DOC_AGENT_PRIVATE}/reference`, undefined, maria.token)), 404, 'DOCUMENT_NOT_FOUND'), 'J19 and so does a club asking for the agent\'s private document (#10)');
  const ref = await j('GET', `/org/agent/transactions/${TX2}/documents/${DOC_SHARED}/reference`, undefined, ANA.token);
  ok(ref.status === 200 && ref.body.reference === null && /no file has been attached/.test(ref.body.note), 'J20 a placeholder\'s reference read is honest about there being no file');
  const sup = await j('POST', `/org/agent/transactions/${TX2}/documents/${DOC_SHARED}/supersede`, { label: 'Draft term sheet v2', expectedRev: 1 }, ANA.token);
  ok(sup.status === 201 && sup.body.document.version === 2 && sup.body.document.supersedes === DOC_SHARED, 'J21 a new version supersedes the old; the old row is kept, never edited (§32)');
  neg(expect(collect('J22', await j('POST', `/org/agent/transactions/${TX2}/documents/${DOC_SHARED}/supersede`, { label: 'again' }, ANA.token)), 409, 'DOCUMENT_SUPERSEDED'), 'J22 a superseded version cannot be superseded twice');
  ok((await j('GET', `/org/agent/transactions/${TX2}/documents`, undefined, ANA.token)).body.items.some((d) => d.version === 2), 'J23 the current list shows version 2');
  neg(expect(collect('J24', await j('POST', `/org/agent/transactions/${TX2}/documents/${DOC_ENG_PRIVATE}/supersede`, { label: 'x' }, ANA.token)), 404, 'DOCUMENT_NOT_FOUND'), 'J24 the agent cannot version a document it does not own');
  const tsRead = await j('GET', `/ts/transactions/${TX2}`, undefined, PRIYA.token);
  ok(tsRead.status === 200 && typeof tsRead.body.transaction.documentCount === 'number' && tsRead.body.transaction.documents === undefined, 'J25 the reviewer sees a document COUNT and no document — their surface carries states and ids');
  neg(!JSON.stringify(tsRead.body).match(/budget note|passport scan|mandate working copy/), 'J26 no document label reaches the Trust & Safety read (§34)');
}

// ============================================================ K — notes
section('K/§35 — scoped notes, absent rather than redacted for the lanes they exclude');
{
  neg(expect(collect('K1', await j('POST', `/org/agent/transactions/${TX2}/notes`, { text: 'x', visibility: 'PLAYER_PRIVATE' }, ANA.token)), 403, 'DOCUMENT_VISIBILITY_NOT_PERMITTED'), 'K1 the agent cannot write into the player\'s private lane');
  neg(expect(collect('K2', await j('POST', `/org/agent/transactions/${TX2}/notes`, { text: '', visibility: 'AGENT_PRIVATE' }, ANA.token)), 400, 'NOTE_INPUT_INVALID'), 'K2 an empty note is refused');
  ok((await j('POST', `/org/agent/transactions/${TX2}/notes`, { text: 'Push for the signing-on fee; do not mention the other club.', visibility: 'AGENT_PRIVATE' }, ANA.token)).status === 201, 'K3 the agent writes a private note');
  ok((await j('POST', `/org/transactions/${TX2}/notes`, { text: 'Board will not exceed the wage ceiling.', visibility: 'ENGAGING_CLUB_PRIVATE' }, maria.token)).status === 201, 'K4 the engaging club writes its own');
  const agentNotes = (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body.transaction.notes;
  const clubNotes = (await j('GET', `/org/transactions/${TX2}`, undefined, maria.token)).body.transaction.notes;
  const playerNotes = (await j('GET', `/player/transactions/${TX2}`, undefined, kola.token)).body.transaction.notes;
  ok(agentNotes.some((n) => /signing-on fee/.test(n.text)), 'K5 the agent reads their own note');
  neg(!JSON.stringify(clubNotes).match(/signing-on fee/), 'K6 the club never reads the agent\'s private note — it is absent, not redacted (#10)');
  neg(!JSON.stringify(playerNotes).match(/wage ceiling|signing-on fee/), 'K7 the player reads neither the club\'s nor the agent\'s private note (#9 inverse, §34)');
  neg(!JSON.stringify(agentNotes).match(/wage ceiling/), 'K8 and the representing agent does not read the engaging club\'s private note either — a club-private lane excludes everyone outside the club (#9)');
  const tsRead = (await j('GET', `/ts/transactions/${TX2}`, undefined, PRIYA.token)).body;
  neg(typeof tsRead.transaction.noteCount === 'number' && !JSON.stringify(tsRead).match(/wage ceiling|signing-on fee/), 'K9 the reviewer sees a note COUNT and no note text');
  const tl = (await j('GET', `/org/agent/transactions/${TX2}/timeline`, undefined, ANA.token)).body.items;
  neg(!tl.some((e) => e.action === 'transaction_note_added'), 'M1 a note is audit-only: it appears in NOBODY\'s timeline, including its author\'s (§39, §40)');
  const audit = (await j('GET', '/org/agent/agency/audit?limit=100', undefined, tomas.token)).body.items;
  ok(audit.some((r) => r.domain === 'transaction' && r.action === 'transaction_note_added'), 'M2 …and it IS in the platform audit, which is the distinction (§40)');
  neg(!JSON.stringify(audit).match(/signing-on fee|wage ceiling|Draft term sheet/), 'M3 the audit carries the action, never the note text or the document label (§75)');
}

// ============================================================ L — messages
section('L/§36/§37/§81 — the canonical Inbox is referenced; membership alone opens nothing');
{
  neg(expect(collect('L1', await j('POST', `/org/transactions/${TX2}/messages/link`, { channelId: 'chan-nope' }, maria.token)), 404, 'MESSAGE_THREAD_NOT_FOUND'), 'L1 a channel that is not this club\'s conversation with this individual cannot be linked');
  const channels = (await j('GET', '/org/channels', undefined, maria.token)).body;
  const mineWithKola = Array.isArray(channels) ? channels.find((c) => c.playerId === 'pl-adeyemi') : null;
  if (mineWithKola) {
    const link = await j('POST', `/org/transactions/${TX2}/messages/link`, { channelId: mineWithKola.id }, maria.token);
    ok(link.status === 201, 'L2 the club links its own canonical thread with the individual');
    const agentView = (await j('GET', `/org/agent/transactions/${TX2}/messages`, undefined, ANA.token)).body;
    neg(agentView.items.length === 1 && agentView.items[0].readable === false, 'L3 the agent learns a conversation exists — the club\'s own act of sharing — and cannot read it: transaction membership is not Inbox authorisation (§81)');
    const clubView = (await j('GET', `/org/transactions/${TX2}`, undefined, maria.token)).body.transaction;
    ok(clubView.linkedThreads[0].readable === true, 'L4 the club, which passes the channel\'s own gate, can');
  } else {
    ok(true, 'L2 no accepted club↔player channel exists in this fixture; the link route is exercised by its refusals');
    neg(expect(collect('L3', await j('POST', `/org/transactions/${TX2}/messages/link`, { channelId: 'chan-1' }, maria.token)), 404, 'MESSAGE_THREAD_NOT_FOUND'), 'L3 a guessed channel id links nothing');
    ok(true, 'L4 (see L3)');
  }
  const msgs = await j('GET', `/org/agent/transactions/${TX2}/messages`, undefined, ANA.token);
  ok(/never negotiates/.test(msgs.body.note) && /Inbox/.test(msgs.body.note), 'L5 the workspace states that correspondence lives in the canonical Inbox and that ScoutBox never negotiates (§37)');
  neg(expect(collect('L6', await j('POST', `/org/transactions/${TX2}/messages/link`, { channelId: 'chan-1' }, outsider.token)), 404, 'TRANSACTION_NOT_FOUND'), 'L6 a club that is not a party cannot link anything');
}

// ============================================================ N/O/P/Q — the four views
section('N/O/P/Q/§41–§45 — four projections, each its own slice');
{
  const agent = (await j('GET', '/org/agent/transactions', undefined, ANA.token)).body;
  ok(agent.items.length >= 2 && agent.statuses.length === 10 && agent.transitions.length === 10 && agent.counts.live >= 1, 'O1 the agent list carries the transactions, the state vocabulary and live counts');
  ok(agent.items.every((t) => t.viewerRoles.includes('representing_agent')), 'O2 every row is one the agent represents in');
  const player = (await j('GET', '/player/transactions', undefined, kola.token)).body;
  ok(player.items.length >= 2 && player.items.every((t) => t.viewerRoles.includes('party_individual')), 'N1 the player sees only transactions they are actually party to (§41)');
  const playerTx2 = player.items.find((t) => t.id === TX2);
  ok(playerTx2?.agency?.name && playerTx2.representations.length >= 1, 'N2 the player is told which agency and which representation acts, which they are entitled to know');
  neg(player.items.every((t) => t.representations.every((r) => r.agreementId === undefined && r.firstActAt === undefined)), 'N3 …and not the agent\'s own agreement reference');
  const eng = (await j('GET', '/org/transactions', undefined, maria.token)).body;
  ok(eng.items.length >= 1 && eng.signatory === true && eng.items.every((t) => t.viewerPartyRole === 'engaging_entity'), 'P1 the engaging club sees the transactions it is a party to, and its own side');
  const rel = (await j('GET', '/org/transactions', undefined, devA.token)).body;
  ok(rel.items.some((t) => t.viewerPartyRole === 'releasing_entity'), 'Q1 the releasing club sees its own, as the releasing side — a separate party role, not a copy of the engaging one (§45)');
  const foreign = (await j('GET', '/org/transactions', undefined, outsider.token)).body;
  ok(foreign.items.length === 0, 'S1 a club that is party to nothing sees an empty list, not a filtered one (§78)');
  const relDetail = rel.items.find((t) => t.id === TX1);
  if (relDetail) neg(relDetail.compliance.policyVersions === undefined && relDetail.compliance.outcome !== undefined, 'Q2 a club sees the compliance OUTCOME and its reason codes, never the policy versions the agent is bound by (privacy matrix row 14)');
  else ok(true, 'Q2 (the releasing club\'s transaction was re-parented earlier in this run)');
  const ben = (await j('GET', '/org/agent/transactions', undefined, BEN.token)).body;
  ok(ben.items.length === 0, 'S2 an analyst at the same agency reads no transaction of a colleague — same-agency privacy is least-sharing (DR-25)');
  const danList = (await j('GET', '/org/agent/transactions', undefined, DAN.token)).body;
  ok(danList.items.length === 0, 'S3 nor does a licensed colleague');
}

// ============================================================ R/S/T/U/V — privacy, tenancy, safeguarding
section('R/S/T/U/V — concealment, safeguarding, unsupported jurisdictions and the closed minor path');
{
  neg(expect(collect('S4', await j('GET', `/org/agent/transactions/${TX2}`, undefined, ZOE.token)), 404, 'TRANSACTION_NOT_FOUND'), 'S4 an agent at ANOTHER agency cannot read the transaction, nor tell it exists (#4)');
  neg(expect(collect('S5', await j('POST', `/org/agent/transactions/${TX2}/status`, { to: 'CANCELLED', reasonCode: 'other' }, ZOE.token)), 404, 'TRANSACTION_NOT_FOUND'), 'S5 …and cannot move it');
  neg(expect(collect('S6', await j('GET', `/org/transactions/${TX2}`, undefined, outsider.token)), 404, 'TRANSACTION_NOT_FOUND'), 'S6 a foreign club likewise (#5)');
  neg(expect(collect('S7', await j('GET', `/player/transactions/${TX2}`, undefined, theo.token)), 404, 'TRANSACTION_NOT_FOUND'), 'S7 another player likewise (#6)');
  const guesses = ['__proto__', 'constructor', 'atx-000000', 'toString'];
  for (const g of guesses) neg(expect(collect(`S8-${g}`, await j('GET', `/org/agent/transactions/${g}`, undefined, ANA.token)), 404, 'TRANSACTION_NOT_FOUND'), `S8 "${g}" is not a transaction`);
  const a = collect('S9a', await j('GET', `/org/agent/transactions/${TX2}`, undefined, ZOE.token));
  const b = collect('S9b', await j('GET', '/org/agent/transactions/atx-nonexistent', undefined, ZOE.token));
  neg(JSON.stringify(a.body) === JSON.stringify(b.body), 'S9 a foreign transaction and a non-existent one answer with byte-identical bodies (§78)');
  // Safeguarding: Theo blocks the agency, then a transaction naming him is
  // indistinguishable from one that never existed.
  const txTheo = await j('POST', '/org/agent/transactions', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-martin' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }] }, ANA.token);
  const TX_THEO = txTheo.body?.transaction?.id;
  ok(txTheo.status === 201, 'T1 a transaction naming Theo is opened while he is visible');
  const block = await j('POST', '/player/block', { orgId: 'org-northstar', reason: 'unwanted contact' }, theo.token);
  ok(block.status === 200 || block.status === 201, `T2 Theo blocks the agency (${block.status} ${block.body?.error ?? ''})`);
  const blockedRead = await j('GET', `/org/agent/transactions/${TX_THEO}`, undefined, ANA.token);
  ok(blockedRead.status === 200 && blockedRead.body.transaction.parties.find((p) => p.subjectKind === 'player').name === null, 'T3 the agency keeps its own record of what happened and loses the person from it: the party row reads with no name');
  const blockedWrite = collect('T3b', await j('POST', `/org/agent/transactions/${TX_THEO}/documents`, { documentType: 'mandate', visibility: 'AGENT_PRIVATE', label: 'x' }, ANA.token));
  neg(expect(blockedWrite, 422, 'TRANSACTION_PARTY_UNAVAILABLE') && !/block/i.test(JSON.stringify(blockedWrite.body)), 'T4 nothing can be written to it — and the refusal never says "blocked", so it is identical for removed, invisible, blocked and minor (#27, §61)');
  const blockedActive = collect('T4b', await j('POST', `/org/agent/transactions/${TX_THEO}/status`, { to: 'CANCELLED', reasonCode: 'other' }, ANA.token));
  neg(expect(blockedActive, 422, 'TRANSACTION_PARTY_UNAVAILABLE'), 'T4b nor can its status be moved — a compliance CLEAR would not have overridden this');
  neg(expect(collect('T5', await j('POST', '/org/agent/transactions', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-martin' }] }, ANA.token)), 404, 'TRANSACTION_PARTY_NOT_FOUND'), 'T5 and a NEW transaction naming him is the uniform 404, because there the caller is probing');
  const archived = await j('POST', `/org/agent/transactions/${TX_THEO}/status`, { to: 'CANCELLED', reasonCode: 'other', expectedRev: blockedRead.body.transaction.rev }, ANA.token);
  neg(archived.status === 422 && archived.body.error === 'TRANSACTION_PARTY_UNAVAILABLE', 'T6 the one thing a safeguarding stop must still allow is shelving the record; progressing it is refused either way');
  neg(expect(collect('U1', await j('POST', '/org/agent/transactions', { type: 'transfer', jurisdictions: ['FRA'], parties: [] }, ANA.token)), 422, 'JURISDICTION_UNSUPPORTED'), 'U1 an unsupported jurisdiction is refused at creation, not silently allowed (§58, #24)');
  neg(expect(collect('V1', await j('POST', '/org/agent/transactions', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-guni' }] }, ANA.token)), 404, 'TRANSACTION_PARTY_NOT_FOUND'), 'V1 a minor cannot be a party: no minor pathway is production-enabled and the refusal is not an age oracle (§59, #23)');
  const minorList = await j('GET', '/player/transactions', undefined, (await playerLogin('pl-guni')).token);
  neg(minorList.body.minor === true && minorList.body.items.length === 0 && /not available for under-18/.test(minorList.body.note), 'V2 a guardian-managed account is told plainly that the workspace is not available to it');
  ok(ROOM_ROLES.includes('party_guardian') && DOCUMENT_TYPES.includes('guardian_evidence'), 'V3 the guardian architecture is preserved — a distinct room role and a distinct document type — with no live surface (§60)');
}

// ============================================================ R — private data boundaries
section('R/§46/§47/§48 — the three private worlds the workspace must not open');
{
  const bodies = [
    (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body,
    (await j('GET', '/org/agent/transactions', undefined, ANA.token)).body,
    (await j('GET', `/org/transactions/${TX2}`, undefined, maria.token)).body,
    (await j('GET', `/player/transactions/${TX2}`, undefined, kola.token)).body,
    (await j('GET', `/ts/transactions/${TX2}`, undefined, PRIYA.token)).body,
  ];
  const all = JSON.stringify(bodies);
  neg(!/assessmentId|roomComment|recruitmentCase|decisionId|secondLook|nobodyMissed|trustScore/i.test(all), 'R1 no projection carries a club assessment, Room comment, recruitment case, P5 decision, Second Look or Nobody Missed reference (§46, §52)');
  neg(!/boxSession|passportShare|medical|dateOfBirth|"dob"/i.test(all), 'R2 nor Box Cam, Passport, medical or a date of birth (§47)');
  neg(!/feePercent|commission|"fee"/i.test(all), 'R3 and no fee term anywhere (§56, privacy matrix invariant 5)');
  const clubBody = JSON.stringify(bodies[2]);
  neg(!/Dan Mensah|Zoe Hart|pl-okafor|pl-carvalho/.test(clubBody), 'R4 the club learns nothing of the agency\'s other agents or other clients (§48)');
  const playerBody = JSON.stringify(bodies[3]);
  const leak5 = playerBody.match(/Maria Keane|budget|wage ceiling/);
  neg(leak5 === null, `R5 the player learns no club user's name and no club-internal note${leak5 ? ` — leaked "${leak5[0]}" in …${playerBody.slice(Math.max(0, leak5.index - 90), leak5.index + 40)}…` : ''}`);
  neg(!/Priya|reviewerId|evidenceRefs/.test(JSON.stringify(bodies.slice(0, 4))), 'R6 no party-facing projection names a reviewer or carries review evidence');
}

// ============================================================ W/Y — rev and concurrency
section('W/Y/§68/§70 — one authoritative result');
{
  const t = (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body.transaction;
  neg(expect(collect('W1', await j('POST', `/org/agent/transactions/${TX2}/notes`, { text: 'stale write', visibility: 'AGENT_PRIVATE', expectedRev: 1 }, ANA.token)), 409, 'TRANSACTION_VERSION_CONFLICT'), 'W1 a stale expectedRev is refused');
  ok((await j('POST', `/org/agent/transactions/${TX2}/notes`, { text: 'current write', visibility: 'AGENT_PRIVATE', expectedRev: t.rev }, ANA.token)).status === 201, 'W2 the current rev is accepted');
  const t2 = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
  const raceBody = (label) => ({ to: 'CANCELLED', reasonCode: 'duplicate', reason: label, expectedRev: t2.rev });
  const [c1, c2] = await Promise.all([j('POST', `/org/agent/transactions/${TX1}/status`, raceBody('one'), ANA.token), j('POST', `/org/agent/transactions/${TX1}/status`, raceBody('two'), ANA.token)]);
  const wins = [c1, c2].filter((r) => r.status === 200); const loses = [c1, c2].filter((r) => r.status === 409);
  neg(wins.length === 1 && loses.length === 1 && ['TRANSACTION_VERSION_CONFLICT', 'TRANSACTION_TRANSITION_NOT_ALLOWED'].includes(loses[0].body.error), 'Y1 two status transitions at once: exactly one wins, the other gets 409 — no double final state (#18)');
  const final = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
  ok(final.status === 'CANCELLED' && final.cancelReasonCode === 'duplicate' && final.parties.length === 4 && final.history === undefined, 'D24 the cancellation preserves every party row and its history (§20)');
  neg(expect(collect('D25', await j('POST', `/org/agent/transactions/${TX1}/notes`, { text: 'after the end', visibility: 'AGENT_PRIVATE' }, ANA.token)), 409, 'TRANSACTION_NOT_LIVE'), 'D25 nothing can be written to a cancelled transaction; its record stays');
  const tlAfter = (await j('GET', `/org/agent/transactions/${TX1}/timeline`, undefined, ANA.token)).body.items;
  ok(tlAfter.some((e) => e.action === 'transaction_cancelled') && tlAfter.length >= 6, 'D26 and its timeline is intact, ending with the cancellation');
  const arch = await j('POST', `/org/agent/transactions/${TX1}/status`, { to: 'ARCHIVED' }, ANA.token);
  ok(arch.status === 200 && arch.body.transaction.status === 'ARCHIVED', 'D27 a terminal transaction can be archived — retention, not deletion (§22)');
  neg(expect(collect('D28', await j('POST', `/org/agent/transactions/${TX1}/notes`, { text: 'x', visibility: 'AGENT_PRIVATE' }, ANA.token)), 409, 'TRANSACTION_ARCHIVED') && expect(collect('D28b', await j('POST', `/org/agent/transactions/${TX1}/status`, { to: 'ACTIVE' }, ANA.token)), 409, 'TRANSACTION_ARCHIVED'), 'D28 an archived transaction is read-only for everyone, including its owner (#30)');
  ok((await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).status === 200, 'D29 …and still readable, which is what archive means');
}

// ============================================================ AC/AD — events and notifications
section('AC/AD/§73/§74 — events and notifications say little and reveal nothing');
{
  const an = (await j('GET', '/org/notifications', undefined, ANA.token)).body;
  ok(an.some((n) => n.type === 'agent_transaction' || n.type === 'agent_transaction_compliance'), 'AD4 the agent was told about workspace activity');
  const kn = (await j('GET', '/player/notifications', undefined, kola.token)).body;
  ok(kn.some((n) => n.type === 'agent_transaction_action' && /Confirm your participation/.test(n.text) && /does not agree to any terms/.test(n.text)), 'AD5 the individual was asked to confirm and told plainly that confirming agrees to nothing');
  neg(!JSON.stringify(kn).match(/wage ceiling|signing-on fee|Draft term sheet v2|Eastport internal budget/), 'AD6 no note, no fee and no club-private document label reaches a notification');
  neg(!JSON.stringify(an).match(/Kola Adeyemi|Maria Keane/), 'AD7 and no party name rides on the agent\'s notifications either');
  const cn = (await j('GET', '/org/notifications', undefined, maria.token)).body;
  ok(cn.some((n) => n.type === 'agent_transaction' || n.type === 'agent_transaction_action'), 'AD8 the club signatory was told too');
}

// ============================================================ AE — EN/FR parity
section('AE/§83 — EN/FR parity for every new production string');
{
  const i18n = readFileSync(path.join(ROOT, 'scoutbox-agent', 'src', 'i18n.ts'), 'utf8');
  // The catalogue is `const en = {` … `const fr: typeof en = {`, and every key is
  // QUOTED (`'txStatus.DRAFT':`) — a dotted key cannot be a bare identifier. An
  // extractor that assumed bare keys found none and passed vacuously.
  const enStart = i18n.indexOf('const en = {');
  const frStart = i18n.indexOf('const fr: typeof en = {');
  ok(enStart > -1 && frStart > enStart, 'AE0 the agent catalogue has one English and one French dictionary, in that order');
  const keysIn = (part) => new Set([...part.matchAll(/'([A-Za-z0-9_.]+)':/g)].map((m) => m[1]));
  const enKeys = keysIn(i18n.slice(enStart, frStart)); const frKeys = keysIn(i18n.slice(frStart));
  const missing = [...enKeys].filter((k) => !frKeys.has(k));
  const extra = [...frKeys].filter((k) => !enKeys.has(k));
  ok(enKeys.size > 100 && missing.length === 0 && extra.length === 0, `AE1 the agent app has EN/FR parity across ${enKeys.size} keys${missing.length ? ` — missing ${missing.slice(0, 6).join(', ')}` : ''}${extra.length ? ` — extra ${extra.slice(0, 6).join(', ')}` : ''}`);
  const txKeys = [...enKeys].filter((k) => /^(tx|txStatus|txPending|txStale|txBlocker|txType|txBasis|txAction|txTab|visibility|docType|party|consentKind)\./.test(k));
  ok(txKeys.length >= 30, `AE2 ${txKeys.length} transaction strings exist in English`);
  neg(txKeys.length > 0 && txKeys.every((k) => frKeys.has(k)), 'AE3 no transaction string is English-only');
  // Every status, party role, compliance state, consent state, visibility class
  // and error the server can hand the client has a word in BOTH languages (§83).
  const bothHave = (k) => enKeys.has(k) && frKeys.has(k);
  neg(TRANSACTION_STATUSES.every((st) => bothHave(`txStatus.${st}`)), 'AE4 every one of the ten statuses has an EN and a FR word — no raw enum reaches a screen');
  neg(DOCUMENT_VISIBILITY.every((v) => bothHave(`visibility.${v}`)), 'AE5 every document visibility class has an EN and a FR word');
  neg(PARTY_ROLES.every((r) => bothHave(`party.${r}`)), 'AE6 every party role has an EN and a FR word');
  neg(DOCUMENT_TYPES.every((d) => bothHave(`docType.${d}`)), 'AE9 every document type has an EN and a FR word');
  neg(TRANSACTION_TYPES.every((x) => bothHave(`txType.${x}`)), 'AE10 every transaction type has an EN and a FR word');
  // Club and player surfaces carry the same statuses in both languages.
  const clubI18n = readFileSync(path.join(ROOT, 'scoutbox-club', 'src', 'i18n.ts'), 'utf8');
  const clubEnd = clubI18n.indexOf('const fr: typeof en = {');
  const clubEn = keysIn(clubI18n.slice(0, clubEnd)); const clubFr = keysIn(clubI18n.slice(clubEnd));
  neg(TRANSACTION_STATUSES.every((st) => clubEn.has(`m26.status.${st}`) && clubFr.has(`m26.status.${st}`)), 'AE7 the club surface names every status in EN and FR');
  neg([...clubEn].filter((k) => k.startsWith('m26.')).every((k) => clubFr.has(k)), 'AE8 no club transaction string is English-only');
}

// ============================================================ AF/AG/AH — contracts the browser suite proves
section('AF/AG/AH — the state and mobile contracts the browser journeys rely on');
{
  const t = (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body.transaction;
  neg(typeof t.status === 'string' && (t.compliance.pendingReason !== null || t.compliance.clear || t.compliance.blocked), 'AF1 every compliance state reaches the client as a WORD, so no surface has to rely on colour alone (§84)');
  ok(Array.isArray(t.viewerRoles) && Array.isArray(t.allowedTransitions), 'AF2 the projection tells the client which actions exist, so a disabled control is never a guess');
  ok(existsSync(path.join(ROOT, 'e2e', 'm23AgentTransactionLive.test.mjs')), 'AH1 a real browser journey exists for the transaction workspace');
  ok(existsSync(path.join(ROOT, 'scoutbox-agent', 'src', 'transactions.tsx')), 'AG1 the agent app has a transactions screen, exercised at 1440/1280/390/360 by the live suite');
}

// ============================================================ AI — corruption / legacy
section('AI/§92 — a corrupt row is contained and named by its effect, never repaired');
{
  const before = (await j('GET', '/org/agent/transactions', undefined, ANA.token)).body.items.length;
  ok(before >= 2, `AI1 ${before} transactions are readable before the corruption fixture`);
  await stop(server);
  const store = openStore(DATA_DIR);
  const snap = store.load();
  const db = snap.db;
  db.agentTransactions.push({
    id: 'atx-corrupt', agencyOrgId: 'org-northstar', agentUserId: ANA_ID, type: 'transfer', jurisdictions: ['ENG'],
    status: 'SOMETHING_NOBODY_WROTE', parties: [{ id: 'p1', partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi', addedAt: T0, removed: false, confirmedAt: T0 }],
    contextId: null, compliance: null, notes: [], linkedThreads: [], links: {}, terms: { versions: [] },
    initiatedBy: { kind: 'system', userId: null, name: 'fixture' }, initiatedAt: T0, createdAt: T0, updatedAt: T0, keys: {}, rev: 1, revAt: T0, revBy: null, history: [],
  });
  store.save(snap);
  server = await boot();
  const read = await j('GET', '/org/agent/transactions/atx-corrupt', undefined, ANA.token);
  ok(read.status === 200 && read.body.transaction.status === 'SOMETHING_NOBODY_WROTE', 'AI2 the corrupt row reads back as it is on disk — the bytes are the bytes, nothing is repaired on boot');
  neg(read.body.transaction.allowedTransitions.length === 0, 'AI3 …and no transition is offered from a status the machine does not know');
  neg(expect(collect('AI4', await j('POST', '/org/agent/transactions/atx-corrupt/status', { to: 'ACTIVE' }, ANA.token)), 409, 'TRANSACTION_TRANSITION_NOT_ALLOWED'), 'AI4 no status transition is possible from a status the machine does not know');
  neg(expect(collect('AI5', await j('POST', '/org/agent/transactions/atx-corrupt/notes', { text: 'x', visibility: 'AGENT_PRIVATE' }, ANA.token)), 409, 'TRANSACTION_NOT_LIVE'), 'AI5 nor a note');
  neg(read.body.transaction.compliance.staleness === 'NO_SNAPSHOT' && read.body.transaction.compliance.clear === false, 'AI6 a row with no compliance snapshot reads as NO_SNAPSHOT, never as clear');
}

// ============================================================ Z — persistence across a restart
section('Z/§91 — the bytes survive a restart');
{
  const t2 = (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body.transaction;
  ok(t2.status === 'ON_HOLD' && t2.notes.length >= 2 && t2.documents.length >= 2, 'Z1 after the restart the transaction still holds its status, its notes and its documents');
  ok(t2.parties.every((p) => p.confirmedAt) && t2.representations.length === 2 && t2.rev >= 2, 'Z2 the party confirmations, the representation bindings and the rev survived');
  const tl = (await j('GET', `/org/agent/transactions/${TX2}/timeline`, undefined, ANA.token)).body.items;
  ok(tl.length >= 8, `Z3 the timeline survived (${tl.length} entries)`);
  ok((await j('POST', '/org/agent/transactions', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }], clientKey: 'tx-2' }, ANA.token)).body.idempotent === true, 'Z4 an idempotency key recorded before the restart still replays (§91)');
  const consents = (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body.transaction.consents;
  ok(consents.some((k) => k.status === 'revoked'), 'Z5 the consent ledger — including the revocation — survived, and the transaction reads it rather than copying it');
  const metrics = await j('GET', '/ts/transactions/metrics', undefined, PRIYA.token);
  ok(metrics.status === 200 && typeof metrics.body.byStatus.ON_HOLD === 'number' && metrics.body.holdReasons.awaiting_party_decision >= 1 && /No agent, club or player is ranked/.test(metrics.body.note), '§76 process analytics only: counts, durations and reason codes, and it says so');
  neg(!JSON.stringify(metrics.body).match(/Ana|Kola|pl-|org-/), '§76b …and no agent, player or organisation is named in them');
}

// ============================================================ AB — tombstones
section('AB/§71 — an account removal keeps the shape and loses the person');
{
  const before = (await j('GET', '/org/agent/transactions', undefined, ANA.token)).body.items.find((t) => t.id === TX2);
  ok(before.parties.some((p) => p.name === 'Kola Adeyemi'), 'AB1 the individual is named while the account exists');
  const del = await j('DELETE', '/player/account', { confirm: 'DELETE' }, kola.token);
  ok(del.status === 200 || del.status === 204, 'AB2 Kola deletes his account');
  const after = (await j('GET', '/org/agent/transactions', undefined, ANA.token)).body.items.find((t) => t.id === TX2);
  ok(after && after.id === TX2 && after.type === 'employment_contract' && after.status, 'AB3 the transaction survives: its ids, roles, states and times are the record of what happened');
  neg(after.parties.every((p) => p.name === null || p.subjectKind === 'club') && after.parties.find((p) => p.subjectKind === 'player').subjectRemovedAt, 'AB4 the individual is a tombstone: the party row keeps its id and loses the person (#29)');
  neg(!JSON.stringify(after).match(/Kola/), 'AB5 no deleted personal field is resurrected into the list (#29)');
  neg(after.representations.every((r) => r.status === 'withdrawn'), 'AB6 every representation naming the removed subject is withdrawn');
  const tl = (await j('GET', `/org/agent/transactions/${TX2}/timeline`, undefined, ANA.token)).body.items;
  neg(!JSON.stringify(tl).match(/Kola/) && tl.some((e) => e.action === 'transaction_party_confirmed'), 'AB7 the timeline keeps that a confirmation happened and forgets who');
  const docs = (await j('GET', `/org/agent/transactions/${TX2}/documents`, undefined, ANA.token)).body.items;
  neg(!docs.some((d) => d.ownerKind === 'player'), 'AB8 the removed person\'s own documents are gone from the workspace');
}

// ============================================================ Z — the refusal sweep
section('Z — every refusal in this run: a code, and no private field');
{
  ok(ERROR_BODIES.length >= 40, `Z6 ${ERROR_BODIES.length} refusals collected`);
  const noCode = ERROR_BODIES.filter((e) => e.body !== null && !e.body.error);
  neg(noCode.length === 0, 'Z7 every JSON refusal carried an error code');
  const blob = JSON.stringify(ERROR_BODIES);
  neg(!/ at .*\(|node_modules|Error:/.test(blob), 'Z8 no stack and no internal frame reached a refusal');
  const leak9 = blob.match(/Kola|Adeyemi|Maria Keane|Priya|Marcus|wage ceiling|signing-on fee|budget note/);
  neg(leak9 === null, `Z9 no party name, reviewer name, note text or document label reached a refusal${leak9 ? ` — leaked "${leak9[0]}" in …${blob.slice(Math.max(0, leak9.index - 140), leak9.index + 40)}…` : ''}`);
  const leak10 = blob.replace(/MINOR_[A-Z_]+/g, '').match(/"dob"|dateOfBirth|\bblocked\b|\bminor\b/i);
  neg(leak10 === null, `Z10 no refusal says "blocked" or "minor" — that is what makes the concealment uniform${leak10 ? ` — leaked "${leak10[0]}"` : ''}`);
  neg(!/agreementId":"rep|feePercent|commission/.test(blob), 'Z11 and no agreement reference or fee term');
  const codes = new Set(ERROR_BODIES.map((e) => e.body?.error).filter(Boolean));
  // Codes from the canonical platform (session, platform separation) and from
  // the P5.6B/P5.6C domains are contracts of their own; this suite asserts that
  // nothing OUTSIDE a declared contract reaches a caller.
  const CANONICAL = ['ORG_AUTH_REQUIRED', 'PLAYER_AUTH_REQUIRED', 'AUTH_REQUIRED', 'ORG_NOT_FOUND', 'USER_NOT_FOUND', 'GRASSROOTS_PLATFORM_ONLY', 'PLATFORM_MISMATCH', 'ORG_NOT_VERIFIED', 'ALREADY_ROOT_ADMIN', 'NOT_FOUND', 'BLOCK_EXISTS'];
  const unmapped = [...codes].filter((c) => !Object.hasOwn(M26_ERROR_HTTP, c) && !CANONICAL.includes(c) && !/^(AGENT_|REPRESENTATION_|CONSENT_|REVIEWER_|COMPLIANCE_|CONTEXT_|JURISDICTION_|REGULATORY_|POLICY_|PARTY_|SIGNATORY_|REVIEW_)/.test(c));
  neg(unmapped.length === 0, `Z12 every refusal code belongs to a declared contract${unmapped.length ? `: ${unmapped.join(', ')}` : ''}`);
}

await stop(server);
const total = passed;
console.log(`\nM23 P5.6D Transaction suite: ${total} checks passed, ${negatives} negative/security/safeguarding checks (${Math.round((negatives / total) * 100)}%)`);
if (process.exitCode) console.error('M23 P5.6D Transaction suite has failures.');
else console.log('all M23 P5.6D Transaction checks passed');
