// The transaction workspace's rules behind the agent transactions battery (e2e/agents/transactions.mjs), checked in
// this process: the state machine and its two maps, the transaction types, party confirmation, the visibility classes,
// the compliance state machine, the party revision, timeline audiences, the offer boundary, the error contract, and
// the declared stores, migration, events, notifications, rate policies and permissions.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  TRANSACTION_TYPES,
  TRANSACTION_STATUSES,
  LIVE_STATUSES,
  TERMINAL_STATUSES,
  PARTY_ROLES,
  ROOM_ROLES,
  ACTOR_TRANSITIONS,
  COMPLIANCE_TRANSITIONS,
  ALL_TRANSITIONS,
  actorTransitionAllowed,
  complianceTransitionAllowed,
  DOCUMENT_TYPES,
  DOCUMENT_VISIBILITY,
  NOTE_VISIBILITY,
  canSeeVisibility,
  uploadableVisibilities,
  complianceStateFrom,
  statusForComplianceState,
  partyRevisionOf,
  snapshotStaleness,
  offerReadiness,
  requiredPartyRoles,
  partiesConfirmed,
  partiesAwaitingConfirmation,
  roomRolesFor,
  clubPartyRoleOf,
  timelineFor,
  timelineAudienceOf,
  timelineVisible,
  actorLabel,
  TIMELINE_AUDIENCES,
  HOLD_REASON_CODES,
  CANCEL_REASON_CODES,
  CLOSE_REASON_CODES,
  TRANSACTION_LIMITS,
  RELEASING_PARTY_TYPES,
  PENDING_REASONS,
} from '../../../domains/agents/transactions/transaction.mjs';
import {
  TRANSACTION_ERROR_HTTP,
  PUBLIC_ERROR_FIELDS,
  publicErrorBody,
} from '../../../domains/agents/transactions/errors.mjs';
import { TRANSACTION_AUDIT_ACTIONS, transactionAuditRows } from '../../../domains/agents/transactions/audit.mjs';
import { PERMISSIONS, can } from '../../../domains/agents/core/shared.mjs';
import {
  CONTEXT_TYPES,
  PARTY_ROLES as ENGINE_PARTY_ROLES,
  PERMITTED_WITH_CONSENT,
} from '../../../domains/agents/compliance/conflict.mjs';
import { EVENT_REGISTRY } from '../../../domains/platform/eventRegistry.mjs';
import { RATE_LIMIT_POLICY } from '../../../domains/platform/rateLimit.mjs';
import { TYPE_CATEGORY, CATEGORIES } from '../../../domains/platform/notificationPrefs.mjs';
import { DATA_MIGRATIONS, TABLE_BACKED } from '../../../repositories/index.mjs';
import { AGENT_TRANSACTIONS_MIGRATION, AGENT_TRANSACTIONS_TABLES } from '../../../repositories/agentTransactions.mjs';
import { openLayer, readRecords, writeFixture } from '../../dataLayerFixture.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, fail, section, done } = rulesSuite('agents/transactions');
const T0 = Date.UTC(2026, 8, 18);

// =================================================================== PURE
section('pure D — the state machine: ten states, two maps, no offer and no signing');
{
  ok(
    TRANSACTION_STATUSES.length === 10 &&
      TRANSACTION_STATUSES[0] === 'DRAFT' &&
      TRANSACTION_STATUSES.at(-1) === 'ARCHIVED',
    'D1 ten explicit states, DRAFT first and ARCHIVED last',
  );
  neg(!TRANSACTION_STATUSES.some((s) => /offer|signed|sign/i.test(s)), 'D2 no state names an offer or a signing');
  neg(
    !TRANSACTION_STATUSES.includes('COMPLETED') && TRANSACTION_STATUSES.includes('CLOSED'),
    'D3 the terminal is the neutral CLOSED, not COMPLETED — COMPLETED would read as a concluded transfer',
  );
  for (const s of TRANSACTION_STATUSES)
    ok(
      Object.hasOwn(ACTOR_TRANSITIONS, s) && Object.hasOwn(COMPLIANCE_TRANSITIONS, s),
      `D4 ${s} appears in both transition maps`,
    );
  const actorTargets = new Set(Object.values(ACTOR_TRANSITIONS).flat());
  neg(
    !actorTargets.has('READY') && !actorTargets.has('COMPLIANCE_PENDING') && !actorTargets.has('COMPLIANCE_BLOCKED'),
    "D5 no actor transition reaches READY, COMPLIANCE_PENDING or COMPLIANCE_BLOCKED — those are the compliance layer's answer, not anyone's request",
  );
  const complianceTargets = new Set(Object.values(COMPLIANCE_TRANSITIONS).flat());
  neg(
    !complianceTargets.has('ACTIVE') &&
      !complianceTargets.has('CANCELLED') &&
      !complianceTargets.has('CLOSED') &&
      !complianceTargets.has('ARCHIVED'),
    'D6 and the compliance layer never cancels, closes, archives or activates a transaction',
  );
  neg(
    COMPLIANCE_TRANSITIONS.DRAFT.length === 0,
    'D7 a DRAFT is never told it is READY: a draft makes no compliance claim',
  );
  neg(
    ACTOR_TRANSITIONS.ARCHIVED.length === 0 && COMPLIANCE_TRANSITIONS.ARCHIVED.length === 0,
    'D8 ARCHIVED is terminal for both maps — archive is retention, not a workflow state',
  );
  neg(
    !actorTransitionAllowed('DRAFT', 'ACTIVE') &&
      !actorTransitionAllowed('DRAFT', 'READY') &&
      !actorTransitionAllowed('CLOSED', 'ACTIVE'),
    'D9 a draft cannot jump to ACTIVE or READY, and a closed transaction cannot reopen',
  );
  ok(
    actorTransitionAllowed('COMPLIANCE_PENDING', 'ACTIVE') && actorTransitionAllowed('COMPLIANCE_BLOCKED', 'ACTIVE'),
    'D9b asking for ACTIVE from a compliance state IS a legal request — it is refused by the compliance gate, with the reason, rather than by the map with a generic one',
  );
  ok(
    statusForComplianceState(
      complianceStateFrom({ outcome: 'CLEAR', representationCount: 0, partiesConfirmed: true }),
    ) === 'PARTIES_CONFIRMED',
    'D9c a confirmed transaction with no representation rests at PARTIES_CONFIRMED: nothing has been asked of compliance yet',
  );
  ok(
    actorTransitionAllowed('READY', 'ACTIVE') &&
      actorTransitionAllowed('ACTIVE', 'ON_HOLD') &&
      actorTransitionAllowed('ON_HOLD', 'ACTIVE') &&
      actorTransitionAllowed('CANCELLED', 'ARCHIVED'),
    'D10 the live path: READY → ACTIVE ⇄ ON_HOLD, and a terminal state can be archived',
  );
  neg(
    !actorTransitionAllowed('__proto__', 'ACTIVE') &&
      !complianceTransitionAllowed('constructor', 'READY') &&
      !actorTransitionAllowed(undefined, 'ACTIVE'),
    'D11 a prototype name and an undefined state authorise nothing (null-prototype tables)',
  );
  ok(
    LIVE_STATUSES.length === 7 &&
      TERMINAL_STATUSES.length === 3 &&
      LIVE_STATUSES.every((s) => !TERMINAL_STATUSES.includes(s)),
    'D12 seven live states and three terminal ones, disjoint',
  );
  ok(
    ALL_TRANSITIONS.length === 10 &&
      ALL_TRANSITIONS.every((r) => Array.isArray(r.byActor) && Array.isArray(r.byCompliance)),
    'D13 the transition map is exported whole, for the document and for the client',
  );
  ok(
    HOLD_REASON_CODES.length >= 5 && CANCEL_REASON_CODES.length >= 5 && CLOSE_REASON_CODES.length >= 3,
    'D14 hold, cancel and close carry reason CODES, so analytics counts them without reading prose',
  );
}

section('pure A — transaction types come from the frozen conflict-engine enum');
{
  ok(
    TRANSACTION_TYPES === CONTEXT_TYPES,
    "A-p1 the type enum is the conflict engine's own object, imported not copied",
  );
  ok(
    TRANSACTION_TYPES.join() === 'employment_contract,transfer,loan,other_services',
    'A-p2 the four frozen types, in order',
  );
  neg(
    !TRANSACTION_TYPES.includes('renewal') && !TRANSACTION_TYPES.includes('permanent_transfer'),
    'A-p3 no "renewal" and no "permanent_transfer": neither was frozen, so both are deferred rather than invented',
  );
  ok(
    PARTY_ROLES === ENGINE_PARTY_ROLES && PARTY_ROLES.join() === 'individual,engaging_entity,releasing_entity',
    "B-p1 the three frozen party roles, also the engine's own",
  );
  ok(
    RELEASING_PARTY_TYPES.join() === 'transfer,loan',
    'B-p2 a releasing entity exists only where the individual leaves someone',
  );
  ok(
    requiredPartyRoles('employment_contract').join() === 'individual,engaging_entity' &&
      requiredPartyRoles('transfer').join() === 'individual,engaging_entity,releasing_entity',
    'B-p3 required parties per type',
  );
  ok(
    ROOM_ROLES.length === 7 && ROOM_ROLES.includes('party_guardian') && ROOM_ROLES.includes('agency_admin_observer'),
    'B-p4 the seven frozen room roles, including the guardian role no build grants yet',
  );
}

section('pure C — party confirmation is by the party itself');
{
  const tx = (parties) => ({ type: 'transfer', parties, history: [] });
  const p = (partyRole, confirmed, removed = false) => ({
    id: `p-${partyRole}`,
    partyRole,
    subjectKind: partyRole === 'individual' ? 'player' : 'club',
    subjectId: `s-${partyRole}`,
    confirmedAt: confirmed ? T0 : null,
    removed,
  });
  neg(
    !partiesConfirmed(tx([p('individual', true), p('engaging_entity', true)])),
    'C-p1 a transfer with no releasing entity is not party-confirmed',
  );
  neg(
    !partiesConfirmed(tx([p('individual', true), p('engaging_entity', false), p('releasing_entity', true)])),
    'C-p2 an unconfirmed engaging club is not confirmation — naming a party is not confirming it',
  );
  ok(
    partiesConfirmed(tx([p('individual', true), p('engaging_entity', true), p('releasing_entity', true)])),
    'C-p3 all three confirmed by their own side → party-confirmed',
  );
  neg(
    !partiesConfirmed(tx([p('individual', true, true), p('engaging_entity', true), p('releasing_entity', true)])),
    'C-p4 a removed party does not count, however confirmed it once was',
  );
  ok(
    partiesAwaitingConfirmation(tx([p('individual', true), p('engaging_entity', false)])).join() ===
      'engaging_entity,releasing_entity',
    'C-p5 the awaiting list names exactly what is missing',
  );
}

section('pure J — nine visibility classes, resolved from roles AND side');
{
  ok(
    DOCUMENT_VISIBILITY.length === 9 && DOCUMENT_VISIBILITY.includes('T_AND_S_ONLY'),
    'J-p1 the nine classes the mandate names',
  );
  ok(
    DOCUMENT_TYPES.length === 9 &&
      DOCUMENT_TYPES.includes('term_sheet_draft') &&
      DOCUMENT_TYPES.includes('employment_contract_draft'),
    'J-p2 nine document types; the contract and term sheet are DRAFTS and say so in their names',
  );
  const agent = ['representing_agent'];
  const player = ['party_individual'];
  const engaging = ['party_club_signatory'];
  const releasing = ['party_club_signatory'];
  const observer = ['agency_admin_observer'];
  const ts = ['trust_safety'];
  ok(canSeeVisibility('AGENT_PRIVATE', agent), 'J-p3 the representing agent reads their own private file');
  neg(
    !canSeeVisibility('AGENT_PRIVATE', observer),
    "J-p4 an agency administrator who can see the transaction cannot read the agent's private file (DR-26) (#10 inverse)",
  );
  neg(
    !canSeeVisibility('AGENT_PRIVATE', player) && !canSeeVisibility('AGENT_PRIVATE', engaging, 'engaging_entity'),
    'J-p5 neither the player nor a club reads an AGENT_PRIVATE document (#10)',
  );
  neg(
    !canSeeVisibility('PLAYER_PRIVATE', engaging, 'engaging_entity') && !canSeeVisibility('PLAYER_PRIVATE', agent),
    'J-p6 a PLAYER_PRIVATE document reaches no club and not even the agent',
  );
  ok(
    canSeeVisibility('ENGAGING_CLUB_PRIVATE', engaging, 'engaging_entity'),
    'J-p7 the engaging club reads its own private file',
  );
  neg(
    !canSeeVisibility('ENGAGING_CLUB_PRIVATE', releasing, 'releasing_entity'),
    'J-p8 the releasing club does NOT — same role name, different side (#8)',
  );
  neg(
    !canSeeVisibility('RELEASING_CLUB_PRIVATE', engaging, 'engaging_entity'),
    'J-p9 and not the other way round either (#7)',
  );
  neg(!canSeeVisibility('ENGAGING_CLUB_PRIVATE', player), 'J-p10 a player never reads a club-private document');
  ok(
    canSeeVisibility('PLAYER_AGENT_SHARED', player) &&
      canSeeVisibility('PLAYER_AGENT_SHARED', agent) &&
      !canSeeVisibility('PLAYER_AGENT_SHARED', engaging, 'engaging_entity'),
    'J-p11 PLAYER_AGENT_SHARED reaches those two and nobody else',
  );
  ok(
    canSeeVisibility('ENGAGING_AGENT_SHARED', engaging, 'engaging_entity') &&
      canSeeVisibility('ENGAGING_AGENT_SHARED', agent) &&
      !canSeeVisibility('ENGAGING_AGENT_SHARED', releasing, 'releasing_entity'),
    'J-p12 ENGAGING_AGENT_SHARED reaches the engaging club and the agent, never the other side',
  );
  ok(
    ['representing_agent', 'party_individual', 'party_club_signatory'].every((r) =>
      canSeeVisibility('ALL_TRANSACTION_PARTIES', [r], 'engaging_entity'),
    ),
    'J-p13 ALL_TRANSACTION_PARTIES reaches every party role',
  );
  neg(
    !canSeeVisibility('ALL_TRANSACTION_PARTIES', ts) && !canSeeVisibility('PLAYER_PRIVATE', ts),
    'J-p14 a reviewer reads NO party document — their surface carries states and ids, not papers',
  );
  ok(canSeeVisibility('T_AND_S_ONLY', ts), 'J-p15 the Trust & Safety lane is readable by Trust & Safety');
  neg(
    DOCUMENT_VISIBILITY.filter((v) =>
      canSeeVisibility(v, ['representing_agent', 'party_individual', 'party_club_signatory'], 'engaging_entity'),
    ).length === 8,
    'J-p16 even holding every party role at once, T_AND_S_ONLY stays out of reach',
  );
  neg(
    !canSeeVisibility('NOT_A_CLASS', agent) &&
      !canSeeVisibility('__proto__', agent) &&
      !canSeeVisibility('constructor', agent),
    'J-p17 an unknown class and a prototype name fail closed',
  );
  neg(
    !canSeeVisibility('AGENT_PRIVATE', []) && !canSeeVisibility('ALL_TRANSACTION_PARTIES', null),
    'J-p18 no roles means no access',
  );
  neg(
    !uploadableVisibilities(agent).includes('T_AND_S_ONLY') && !uploadableVisibilities(ts).includes('T_AND_S_ONLY'),
    'J-p19 nobody may FILE into the Trust & Safety lane, including Trust & Safety',
  );
  neg(
    !uploadableVisibilities(player, 'individual').some((v) => /CLUB|ENGAGING|RELEASING/.test(v)),
    'J-p20 a player cannot classify a document into a club lane',
  );
  ok(
    uploadableVisibilities(player, 'individual').join() ===
      'PLAYER_PRIVATE,PLAYER_AGENT_SHARED,ALL_TRANSACTION_PARTIES',
    'J-p21 what a player may file: their own, shared with the agent, or shared with everyone',
  );
  ok(
    NOTE_VISIBILITY.length === 8 && !NOTE_VISIBILITY.includes('T_AND_S_ONLY'),
    'K-p1 notes reuse the document classes minus the Trust & Safety lane — one vocabulary, not two',
  );
}

section('pure F — the compliance state machine names its reason');
{
  const st = (o) => complianceStateFrom(o);
  ok(
    st({ outcome: 'CLEAR', representationCount: 1, partiesConfirmed: true }).clear === true,
    'F-p1 CLEAR with a representation is clear',
  );
  neg(
    st({ outcome: 'CLEAR', representationCount: 0, partiesConfirmed: true }).pendingReason === 'REPRESENTATION_MISSING',
    'F-p2 CLEAR with NO representation is not a clearance to proceed: nobody holds authority yet',
  );
  neg(
    st({ outcome: 'CLEAR', representationCount: 1, partiesConfirmed: false }).pendingReason === 'PARTIES_NOT_CONFIRMED',
    'F-p3 unconfirmed parties come before any engine answer',
  );
  neg(
    st({ outcome: 'PROHIBITED_CONFLICT', representationCount: 1, partiesConfirmed: true }).blocked === true,
    'F-p4 PROHIBITED_CONFLICT is blocked, not pending',
  );
  neg(
    st({ outcome: PERMITTED_WITH_CONSENT, representationCount: 1, partiesConfirmed: true }).pendingReason ===
      'CONSENT_REQUIRED',
    'F-p5 consent outstanding is named CONSENT_REQUIRED, never a generic pending',
  );
  neg(
    st({ outcome: 'MANUAL_REGULATORY_REVIEW_REQUIRED', representationCount: 1, partiesConfirmed: true })
      .pendingReason === 'MANUAL_REVIEW',
    'F-p6 manual review is named',
  );
  neg(
    st({ outcome: 'INSUFFICIENT_DATA', representationCount: 1, partiesConfirmed: true }).pendingReason ===
      'INSUFFICIENT_DATA',
    'F-p7 insufficient data is named',
  );
  neg(
    st({ gate: 'PROVIDER_UNAVAILABLE', partiesConfirmed: true }).pendingReason === 'PROVIDER_UNAVAILABLE' &&
      st({ gate: 'JURISDICTION_UNSUPPORTED', partiesConfirmed: true }).pendingReason === 'JURISDICTION_UNSUPPORTED',
    'F-p8 a gate refusal before the engine keeps its own reason',
  );
  neg(
    st({ outcome: 'SOMETHING_ELSE', representationCount: 1, partiesConfirmed: true }).clear === false,
    'F-p9 an unknown outcome is never clear',
  );
  ok(
    statusForComplianceState(st({ outcome: 'CLEAR', representationCount: 1, partiesConfirmed: true })) === 'READY' &&
      statusForComplianceState(st({ outcome: 'PROHIBITED_CONFLICT', partiesConfirmed: true })) === 'COMPLIANCE_BLOCKED',
    'F-p10 clear → READY, blocked → COMPLIANCE_BLOCKED',
  );
  ok(
    statusForComplianceState(st({ outcome: 'CLEAR', partiesConfirmed: false })) === 'PARTIES_CONFIRMED' &&
      statusForComplianceState(null) === null,
    'F-p11 unconfirmed parties fall back to PARTIES_CONFIRMED; no state says nothing',
  );
  ok(
    PENDING_REASONS.length === 8 && PENDING_REASONS.every((r) => /^[A-Z_]+$/.test(r)),
    'F-p12 eight named pending reasons, all codes',
  );
}

section('pure G — the party revision covers the eight inputs staleness is measured on');
{
  const base = {
    parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-1', confirmedAt: T0 }],
    agentUserId: 'a1',
    representations: [{ agentUserId: 'a1', partyRole: 'individual', status: 'verified', agreementId: 'ag1' }],
    consents: [{ id: 'c1', status: 'granted' }],
    facetStates: { fifa_licence: 'VERIFIED' },
    policyVersions: ['jp-eng-2026-27-1'],
    blockedSubjectIds: [],
    minorSubjectIds: [],
  };
  const h0 = partyRevisionOf(base);
  ok(
    /^[0-9a-f]{64}$/.test(h0) && partyRevisionOf({ ...base }) === h0,
    'G-p1 the revision is a stable hash of the inputs',
  );
  const changes = [
    [
      'parties',
      { parties: [...base.parties, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-1' }] },
    ],
    ['the agent', { agentUserId: 'a2' }],
    ['representations', { representations: [{ ...base.representations[0], status: 'withdrawn' }] }],
    ['consents', { consents: [{ id: 'c1', status: 'revoked' }] }],
    ['licence facets', { facetStates: { fifa_licence: 'STALE' } }],
    ['policy versions', { policyVersions: ['jp-eng-2026-27-2'] }],
    ['safeguarding', { blockedSubjectIds: ['pl-1'] }],
    ['minor state', { minorSubjectIds: ['pl-1'] }],
  ];
  for (const [what, patch] of changes)
    neg(
      partyRevisionOf({ ...base, ...patch }) !== h0,
      `G-p2 a change to ${what} changes the revision — so the old evaluation is stale by definition, not by heuristic`,
    );
  neg(
    partyRevisionOf({ ...base, parties: [{ ...base.parties[0], confirmedAt: null }] }) !== h0,
    "G-p3 losing a party's confirmation changes it too",
  );
  ok(
    partyRevisionOf({ ...base, policyVersions: ['jp-eng-2026-27-1'] }) === h0 &&
      partyRevisionOf({ ...base, parties: [...base.parties] }) === h0,
    'G-p4 re-ordering nothing changes nothing: the hash is canonical',
  );
  neg(
    snapshotStaleness({ compliance: null }, h0) === 'NO_SNAPSHOT',
    'G-p5 no snapshot is stale — the absence of an evaluation is never a clearance',
  );
  neg(
    snapshotStaleness({ compliance: { evaluationId: 'e1', partyRevision: 'other' } }, h0) === 'INPUTS_CHANGED',
    'G-p6 a different revision is INPUTS_CHANGED',
  );
  neg(
    snapshotStaleness({ compliance: { evaluationId: 'e1', partyRevision: h0 }, reEvaluationPending: true }, h0) ===
      'POLICY_CHANGED',
    'G-p7 a policy publication flag is POLICY_CHANGED',
  );
  ok(
    snapshotStaleness({ compliance: { evaluationId: 'e1', partyRevision: h0 } }, h0) === null,
    'G-p8 a matching revision with no flag is current',
  );
  neg(
    snapshotStaleness({ compliance: { evaluationId: 'e1', partyRevision: h0, evaluatedAt: T0 } }, h0, {
      now: T0 + 10,
      maxAgeMs: 5,
    }) === 'EXPIRED',
    'G-p9 an age bound, where one is configured, is EXPIRED',
  );
}

section('pure M — timeline audiences, and the audit that is not a timeline');
{
  ok(
    TIMELINE_AUDIENCES.length === 6 && TIMELINE_AUDIENCES.includes('audit_only'),
    "M-p1 six audiences, one of which reaches nobody's timeline",
  );
  ok(
    timelineAudienceOf('transaction_note_added') === 'audit_only',
    "M-p2 a scoped note is audit-only: an internal note is not a club's timeline entry",
  );
  ok(
    timelineAudienceOf('transaction_representation_attached') === 'agent_only',
    "M-p3 a representation is the agent's regulated act, in the agent's lane",
  );
  ok(
    timelineAudienceOf('transaction_status_changed') === 'all_parties' &&
      timelineAudienceOf('transaction_party_confirmed') === 'all_parties',
    'M-p4 status and confirmation reach every party',
  );
  ok(
    timelineAudienceOf('something_unregistered') === 'audit_only',
    'M-p5 an unregistered action fails closed to audit-only',
  );
  neg(
    !timelineVisible('audit_only', ['representing_agent']) && !timelineVisible('audit_only', ['trust_safety']),
    'M-p6 audit_only reaches nobody — not the agent, not a reviewer',
  );
  neg(
    !timelineVisible('agent_only', ['party_club_signatory'], 'engaging_entity') &&
      !timelineVisible('agent_only', ['party_individual']),
    'M-p7 the agent lane reaches no club and no player',
  );
  ok(
    timelineVisible('all_parties', ['party_individual']) &&
      timelineVisible('player_and_agent', ['party_individual']) &&
      !timelineVisible('player_and_agent', ['party_club_signatory'], 'engaging_entity'),
    'M-p8 all_parties and player_and_agent behave as named',
  );
  neg(!timelineVisible('all_parties', []), 'M-p9 a non-party sees no timeline at all');
  // D11: an entry ABOUT a document is only as visible as the document.
  ok(
    timelineAudienceOf('transaction_document_added') === 'per_document' &&
      timelineAudienceOf('transaction_document_superseded') === 'per_document',
    'M-p10 a document entry takes its audience from the document, not from "every party"',
  );
  neg(
    !timelineVisible('per_document', ['party_club_signatory'], 'engaging_entity', { visibility: 'AGENT_PRIVATE' }),
    'M-p11 a club is never told that an AGENT_PRIVATE document was added — the class would leak with the announcement (D11)',
  );
  neg(
    !timelineVisible('per_document', ['party_individual'], null, { visibility: 'ENGAGING_CLUB_PRIVATE' }) &&
      !timelineVisible('per_document', ['party_club_signatory'], 'engaging_entity', {
        visibility: 'RELEASING_CLUB_PRIVATE',
      }),
    'M-p12 …and the same holds for a club-private document facing the individual, and for one club facing the other',
  );
  ok(
    timelineVisible('per_document', ['party_individual'], null, { visibility: 'ALL_TRANSACTION_PARTIES' }) &&
      timelineVisible('per_document', ['representing_agent'], null, { visibility: 'AGENT_PRIVATE' }),
    'M-p13 a shared document still reaches every party, and the agent still sees their own',
  );
  neg(
    !timelineVisible('per_document', ['party_individual'], null, {}) &&
      !timelineVisible('per_document', ['party_individual'], null, null),
    'M-p14 a document entry with no class recorded reaches nobody — it fails closed',
  );
  const tx = {
    history: [
      {
        id: 'h1',
        at: T0,
        action: 'transaction_created',
        by: { kind: 'org', userId: 'u1', name: 'Ana Costa' },
        detail: { count: 2, secret: 'fee 12%' },
      },
      {
        id: 'h2',
        at: T0 + 1,
        action: 'transaction_note_added',
        by: { kind: 'org', userId: 'u1', name: 'Ana' },
        detail: { visibility: 'AGENT_PRIVATE' },
      },
    ],
  };
  const clubTl = timelineFor(tx, ['party_club_signatory'], 'engaging_entity');
  ok(
    clubTl.length === 1 && clubTl[0].action === 'transaction_created',
    'M-p10 the club timeline holds the creation and not the note',
  );
  neg(
    JSON.stringify(clubTl).includes('fee 12%') === false && clubTl[0].detail.count === 2,
    'M-p11 timeline detail is the allowlist: the count survives, an unlisted key does not',
  );
  neg(
    clubTl[0].actor.label === 'Representing agent' && !JSON.stringify(clubTl).includes('Ana'),
    'M-p12 the actor is a ROLE: a club never learns which named person at the agency acted',
  );
  ok(
    actorLabel({ kind: 'ts_reviewer', userId: 'tsr-1', name: 'Priya Shah' }).label === 'Trust & Safety (attributed)' &&
      !JSON.stringify(actorLabel({ kind: 'ts_reviewer', name: 'Priya Shah' })).includes('Priya'),
    'M-p13 a reviewer appears as the attributed role, never by name',
  );
  ok(
    actorLabel({ kind: 'club_user', name: 'Maria Keane' }).label === 'Club signatory' &&
      actorLabel({ kind: 'player', name: 'Kola' }).label === 'Player',
    'M-p14 a club user and a player are labels too',
  );
  ok(actorLabel(null) === null, 'M-p15 no actor is no label');
}

section('pure — the offer boundary is a readiness boolean and its blockers');
{
  const tx = (status, confirmed = true) => ({
    status,
    parties: [
      { partyRole: 'individual', removed: false, confirmedAt: confirmed ? T0 : null },
      { partyRole: 'engaging_entity', removed: false, confirmedAt: confirmed ? T0 : null },
    ],
  });
  const clear = { clear: true };
  const r1 = offerReadiness(tx('READY'), { complianceState: clear, staleness: null });
  ok(
    r1.canStartOfferWorkflow === true && r1.blockers.length === 0 && /No offer exists/.test(r1.honest),
    'O-p1 READY + clear + current → readiness true, and it says no offer exists',
  );
  neg(
    offerReadiness(tx('DRAFT'), { complianceState: clear }).blockers.includes('TRANSACTION_NOT_READY'),
    'O-p2 a draft is not ready for an offer',
  );
  neg(
    offerReadiness(tx('READY'), { complianceState: clear, staleness: 'INPUTS_CHANGED' }).blockers.includes(
      'COMPLIANCE_SNAPSHOT_STALE',
    ),
    'O-p3 a stale snapshot blocks readiness (#11)',
  );
  neg(
    offerReadiness(tx('READY'), { complianceState: { clear: false } }).blockers.includes('COMPLIANCE_NOT_CLEAR'),
    'O-p4 compliance that is not clear blocks readiness',
  );
  neg(
    offerReadiness(tx('READY', false), { complianceState: clear }).blockers.includes('INDIVIDUAL_NOT_CONFIRMED'),
    'O-p5 an unconfirmed individual blocks readiness',
  );
  neg(offerReadiness(null).canStartOfferWorkflow === false, 'O-p6 no transaction, no readiness');
  neg(
    !JSON.stringify(offerReadiness(tx('READY'), { complianceState: clear })).match(
      /offerId|offerRecord|offer_made|offer_accepted/,
    ),
    'O-p7 the readiness object names no offer record, because none exists',
  );
}

section('pure — the error contract conceals, and never carries private material');
{
  ok(
    TRANSACTION_ERROR_HTTP.TRANSACTION_NOT_FOUND === 404 &&
      TRANSACTION_ERROR_HTTP.TRANSACTION_PARTY_NOT_FOUND === 404 &&
      TRANSACTION_ERROR_HTTP.DOCUMENT_NOT_FOUND === 404,
    'Z-p1 every "you may not know whether this exists" answer is 404',
  );
  ok(
    TRANSACTION_ERROR_HTTP.TRANSACTION_COMPLIANCE_BLOCKED === 422 &&
      TRANSACTION_ERROR_HTTP.TRANSACTION_COMPLIANCE_STALE === 422 &&
      TRANSACTION_ERROR_HTTP.TRANSACTION_TRANSITION_NOT_ALLOWED === 409,
    'Z-p2 a policy refusal is 422; a state refusal is 409',
  );
  neg(
    !PUBLIC_ERROR_FIELDS.includes('text') &&
      !PUBLIC_ERROR_FIELDS.includes('label') &&
      !PUBLIC_ERROR_FIELDS.includes('name') &&
      !PUBLIC_ERROR_FIELDS.includes('fee'),
    'Z-p3 no note text, no document label, no name and no fee is a public error field',
  );
  const body = publicErrorBody({
    error: 'TRANSACTION_NOT_FOUND',
    message: 'No transaction',
    stack: 'x',
    internalNote: 'Ana',
    text: 'secret',
    fee: '12%',
    reasons: [{ code: 'C', ruleId: 'R', note: 'prose' }],
  });
  neg(
    body.stack === undefined && body.internalNote === undefined && body.text === undefined && body.fee === undefined,
    'Z-p4 the allowlist drops everything it does not name',
  );
  neg(
    body.reasons[0].note === undefined && body.reasons[0].code === 'C',
    'Z-p5 a reason reaches the wire as a code and a rule reference, never as prose',
  );
  ok(
    publicErrorBody({ error: 'TRANSACTION_STATE_UNKNOWN', message: 'internal detail' }).message ===
      'The transaction service cannot serve this request. This has been recorded.',
    'Z-p6 a 500 says nothing about itself',
  );
}

section('pure AA/AC/AD — stores, migration, events, notifications, rate policies, permissions');
{
  for (const s of ['agentTransactions', 'transactionRepresentations', 'transactionDocuments'])
    ok(TABLE_BACKED.includes(s), `AA1 ${s} is a table of the agent transactions repository, not a collection`);
  ok(
    DATA_MIGRATIONS.filter((m) => m.id === AGENT_TRANSACTIONS_MIGRATION).length === 1,
    `AA2 exactly one migration creates the transaction tables (${AGENT_TRANSACTIONS_MIGRATION})`,
  );
  neg(
    !AGENT_TRANSACTIONS_TABLES.some((t) => /offer|signing|recruitment_case|compliance_context/.test(t)),
    'AA4 the migration reinterprets no existing record as a transaction and creates no offer or signing table',
  );
  const freshDir = mkdtempSync(path.join(tmpdir(), 'sbx-m26-fresh-'));
  const fresh = readRecords(freshDir);
  ok(
    fresh.agentTransactions.length === 0 &&
      fresh.transactionRepresentations.length === 0 &&
      fresh.transactionDocuments.length === 0,
    'AA5 a clean database holds no transaction: the migration backfills nothing',
  );
  const reopened = openLayer(freshDir);
  ok(
    readRecords(freshDir).agentTransactions.length === 0 &&
      reopened.sqlite
        .prepare('SELECT COUNT(*) AS n FROM data_migrations WHERE id = ?')
        .get(AGENT_TRANSACTIONS_MIGRATION).n === 1,
    'AA6 reopening the file records the migration once and creates nothing',
  );
  reopened.close();
  const EVENTS = [
    'agent_transaction_created',
    'agent_transaction_party_changed',
    'agent_transaction_compliance_updated',
    'agent_transaction_status_changed',
    'agent_transaction_document_added',
    'agent_transaction_message_linked',
    'agent_transaction_held',
    'agent_transaction_cancelled',
    'agent_transaction_closed',
  ];
  for (const e of EVENTS) {
    const reg = EVENT_REGISTRY[e];
    ok(
      reg?.audience === 'org_private' && reg.privacyClass === 'org_internal' && reg.analyticsEligible === false,
      `AC1 ${e} is org_private, org_internal and never analytics-eligible`,
    );
    neg(
      reg.payload.every((k) => ['orgId', 'txId', 'partyRole', 'status', 'outcome', 'docId'].includes(k)),
      `AC2 ${e} carries ids and state words only`,
    );
  }
  neg(
    EVENTS.every(
      (e) => !EVENT_REGISTRY[e].payload.includes('playerId') && !EVENT_REGISTRY[e].payload.includes('label'),
    ),
    'AC3 no transaction event carries a player id or a document label',
  );
  neg(
    !EVENT_REGISTRY.offer_made && !EVENT_REGISTRY.agent_transaction_signed && !EVENT_REGISTRY.offer_accepted,
    'AC4 no offer and no signing event is registered',
  );
  ok(
    TYPE_CATEGORY.agent_transaction === 'transaction_updates' &&
      TYPE_CATEGORY.agent_transaction_action === 'transaction_updates',
    'AD1 workspace traffic is the transaction_updates category',
  );
  ok(
    TYPE_CATEGORY.agent_transaction_compliance === 'compliance' && CATEGORIES.compliance.mandatory === true,
    'AD2 the compliance half goes to the mandatory category — a regulatory change cannot be muted',
  );
  ok(
    CATEGORIES.transaction_updates.default === true && CATEGORIES.transaction_updates.mandatory === false,
    'AD3 transaction_updates is on by default and mutable — operational traffic is not an obligation',
  );
  for (const [k, scope] of [
    ['transaction_write', 'actor'],
    ['transaction_status_write', 'actor'],
    ['transaction_document_write', 'actor'],
    ['transaction_note_write', 'actor'],
  ])
    ok(RATE_LIMIT_POLICY[k]?.scope === scope && RATE_LIMIT_POLICY[k].max > 0, `AA7 rate policy ${k}`);
  ok(
    can(['licensed_agent'], 'transactions.write') && PERMISSIONS['transactions.read'].length === 5,
    "AA8 writing a transaction is the licensed individual's; reading is every member's",
  );
  neg(
    !can(['agency_admin'], 'transactions.write') &&
      !can(['analyst'], 'transactions.write') &&
      !can(['assistant'], 'transactions.write') &&
      !can(['finance'], 'transactions.write'),
    'AA9 no agency support role may write a transaction (#2, #3)',
  );
  ok(
    TRANSACTION_AUDIT_ACTIONS.has('transaction_note_added') &&
      TRANSACTION_AUDIT_ACTIONS.has('transaction_status_changed') &&
      !TRANSACTION_AUDIT_ACTIONS.has('offer_made'),
    'AA10 the audit lists the note the timeline hides, and no offer action',
  );
  ok(transactionAuditRows({}).length === 0, 'AA11 the audit projection is pure over an empty db');
  ok(
    TRANSACTION_LIMITS.parties === 4 && TRANSACTION_LIMITS.note === 2000 && TRANSACTION_LIMITS.documents === 200,
    'AA12 explicit bounds on parties, note length and document count',
  );
}

section('AI — the machine has no transition from a status nobody wrote');
{
  neg(
    !actorTransitionAllowed('SOMETHING_NOBODY_WROTE', 'ACTIVE') &&
      !ALL_TRANSITIONS.some((t) => t.from === 'SOMETHING_NOBODY_WROTE'),
    'AI3 …and no transition exists from a status the machine does not know',
  );
}

done();
