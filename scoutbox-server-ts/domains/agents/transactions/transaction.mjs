/**
 * The agent transaction workspace's pure layer: state machine, visibility, staleness and timeline rules.
 *
 * A transaction is a permissioned multi-party workspace, not an offer or a signing. Its neutral terminal is CLOSED
 * rather than COMPLETED, because "completed" reads as a concluded transfer.
 */

import { inputHashOf, PARTY_ROLES, CONTEXT_TYPES, PERMITTED_WITH_CONSENT } from '../compliance/conflict.mjs';

export { PARTY_ROLES, PERMITTED_WITH_CONSENT };

/** `transfer` is a permanent transfer, `employment_contract` a free-agent engagement; there is no `renewal` type. */
export const TRANSACTION_TYPES = CONTEXT_TYPES;

/** A releasing entity exists only where the individual leaves someone. */
export const RELEASING_PARTY_TYPES = Object.freeze(['transfer', 'loan']);

/**
 *   DRAFT               parties named but not all confirmed; no compliance claim.
 *   PARTIES_CONFIRMED   every required party has confirmed itself (a club by its recorded signatory).
 *   COMPLIANCE_PENDING  compliance cannot yet permit progression; `pendingReason` says why.
 *   COMPLIANCE_BLOCKED  an active encoded rule prohibits the combination; a reviewer cannot approve past it.
 *   READY               permitted under the encoded rules. Not "legally valid" or "FIFA approved".
 *   ACTIVE              the parties are using the workspace.
 *   ON_HOLD             held with a reason; leaving it re-checks compliance.
 *   CANCELLED           ended without conclusion.
 *   CLOSED              the neutral operational terminal.
 *   ARCHIVED            a retention state, never a deletion.
 */
export const TRANSACTION_STATUSES = Object.freeze([
  'DRAFT',
  'PARTIES_CONFIRMED',
  'COMPLIANCE_PENDING',
  'COMPLIANCE_BLOCKED',
  'READY',
  'ACTIVE',
  'ON_HOLD',
  'CANCELLED',
  'CLOSED',
  'ARCHIVED',
]);

export const LIVE_STATUSES = Object.freeze([
  'DRAFT',
  'PARTIES_CONFIRMED',
  'COMPLIANCE_PENDING',
  'COMPLIANCE_BLOCKED',
  'READY',
  'ACTIVE',
  'ON_HOLD',
]);
export const TERMINAL_STATUSES = Object.freeze(['CANCELLED', 'CLOSED', 'ARCHIVED']);

const nullProto = (o) => Object.freeze(Object.assign(Object.create(null), o));
/** A row with no parties array belongs to nobody, rather than failing every party's list route. */
const partiesOf = (tx) => (Array.isArray(tx?.parties) ? tx.parties : []);

/** READY and the COMPLIANCE_* states are absent: they are the compliance layer's answer, not anyone's request. */
export const ACTOR_TRANSITIONS = nullProto({
  DRAFT: ['PARTIES_CONFIRMED', 'CANCELLED'],
  PARTIES_CONFIRMED: ['CANCELLED'],
  // Requestable so that compliance refuses it with the real reason, rather than this map with a generic one.
  COMPLIANCE_PENDING: ['ACTIVE', 'CANCELLED'],
  COMPLIANCE_BLOCKED: ['ACTIVE', 'CANCELLED'],
  READY: ['ACTIVE', 'ON_HOLD', 'CANCELLED'],
  ACTIVE: ['ON_HOLD', 'CLOSED', 'CANCELLED'],
  ON_HOLD: ['ACTIVE', 'CLOSED', 'CANCELLED'],
  CANCELLED: ['ARCHIVED'],
  CLOSED: ['ARCHIVED'],
  ARCHIVED: [],
});

/** A draft makes no compliance claim, so an evaluation never moves it. */
export const COMPLIANCE_TRANSITIONS = nullProto({
  DRAFT: [],
  PARTIES_CONFIRMED: ['READY', 'COMPLIANCE_PENDING', 'COMPLIANCE_BLOCKED'],
  COMPLIANCE_PENDING: ['READY', 'COMPLIANCE_BLOCKED', 'PARTIES_CONFIRMED'],
  COMPLIANCE_BLOCKED: ['READY', 'COMPLIANCE_PENDING', 'PARTIES_CONFIRMED'],
  READY: ['COMPLIANCE_PENDING', 'COMPLIANCE_BLOCKED'],
  ACTIVE: ['COMPLIANCE_PENDING', 'COMPLIANCE_BLOCKED'],
  ON_HOLD: [],
  CANCELLED: [],
  CLOSED: [],
  ARCHIVED: [],
});

/** A transaction that loses a confirmed party falls back to PARTIES_CONFIRMED out of any compliance claim. */
export const PARTY_CHANGE_TRANSITIONS = nullProto({
  DRAFT: ['PARTIES_CONFIRMED'],
  READY: ['PARTIES_CONFIRMED'],
  ACTIVE: ['PARTIES_CONFIRMED'],
  COMPLIANCE_PENDING: ['PARTIES_CONFIRMED'],
  COMPLIANCE_BLOCKED: ['PARTIES_CONFIRMED'],
});

export const actorTransitionAllowed = (from, to) =>
  typeof from === 'string' && Object.hasOwn(ACTOR_TRANSITIONS, from) && ACTOR_TRANSITIONS[from].includes(to);
export const complianceTransitionAllowed = (from, to) =>
  typeof from === 'string' && Object.hasOwn(COMPLIANCE_TRANSITIONS, from) && COMPLIANCE_TRANSITIONS[from].includes(to);

export const ALL_TRANSITIONS = Object.freeze(
  TRANSACTION_STATUSES.map((from) => ({
    from,
    byActor: ACTOR_TRANSITIONS[from] ?? [],
    byCompliance: COMPLIANCE_TRANSITIONS[from] ?? [],
  })),
);

// ------------------------------------------------------------------ room roles

/**
 * Not the Recruitment Room roles, which carry club-internal meaning. `party_guardian` is never granted: no minor
 * transaction pathway is enabled.
 */
export const ROOM_ROLES = Object.freeze([
  'representing_agent',
  'party_individual',
  'party_guardian',
  'party_club_signatory',
  'party_club_member',
  'agency_admin_observer',
  'trust_safety',
]);

/** `viewer` is what the server derived (e.g. whether the user is a recorded signatory), never a request's claim. */
export function roomRolesFor(tx, viewer) {
  const roles = [];
  if (!tx || !viewer) return roles;
  const live = (p) => p && !p.removed;
  const parties = partiesOf(tx);
  if (viewer.kind === 'ts_reviewer') return ['trust_safety'];
  if (viewer.kind === 'player') {
    if (parties.some((p) => live(p) && p.subjectKind === 'player' && p.subjectId === viewer.playerId))
      roles.push('party_individual');
    return roles;
  }
  if (viewer.kind === 'agency') {
    if (tx.agencyOrgId !== viewer.orgId) return roles;
    if (tx.agentUserId === viewer.userId) roles.push('representing_agent');
    else if (viewer.agencyAdmin) roles.push('agency_admin_observer');
    return roles;
  }
  if (viewer.kind === 'club') {
    if (!parties.some((p) => live(p) && p.subjectKind === 'club' && p.subjectId === viewer.orgId)) return roles;
    roles.push(viewer.signatory ? 'party_club_signatory' : 'party_club_member');
  }
  return roles;
}

export { partiesOf };

export const clubPartyRoleOf = (tx, orgId) =>
  partiesOf(tx).find((p) => p && !p.removed && p.subjectKind === 'club' && p.subjectId === orgId)?.partyRole ?? null;

// ------------------------------------------------------------------ documents

/**
 * Classifications of records in the evidence vault: no bytes are stored here, so there is no second upload path to
 * secure. The contract and term sheet types are drafts by name because nothing here is signed.
 */
export const DOCUMENT_TYPES = Object.freeze([
  'representation_agreement_reference',
  'compliance_consent_reference',
  'guardian_evidence',
  'mandate',
  'term_sheet_draft',
  'employment_contract_draft',
  'club_document',
  'regulatory_evidence',
  'correspondence_attachment',
]);

/**
 * A class names roles, never user ids, so a document cannot be shown to someone by writing their id into a field.
 * No party may file into `T_AND_S_ONLY`.
 */
export const DOCUMENT_VISIBILITY = Object.freeze([
  'AGENT_PRIVATE',
  'PLAYER_PRIVATE',
  'ENGAGING_CLUB_PRIVATE',
  'RELEASING_CLUB_PRIVATE',
  'PLAYER_AGENT_SHARED',
  'ENGAGING_AGENT_SHARED',
  'RELEASING_AGENT_SHARED',
  'ALL_TRANSACTION_PARTIES',
  'T_AND_S_ONLY',
]);

/**
 * `AGENT_PRIVATE` omits `agency_admin_observer`: a same-agency colleague is one agent for conflicts but a separate
 * person for data. Only `T_AND_S_ONLY` admits `trust_safety`; reviewers read states and ids, not documents.
 */
const VISIBILITY_ROLES = nullProto({
  AGENT_PRIVATE: ['representing_agent'],
  PLAYER_PRIVATE: ['party_individual', 'party_guardian'],
  ENGAGING_CLUB_PRIVATE: ['party_club_signatory', 'party_club_member'],
  RELEASING_CLUB_PRIVATE: ['party_club_signatory', 'party_club_member'],
  PLAYER_AGENT_SHARED: ['representing_agent', 'party_individual', 'party_guardian'],
  ENGAGING_AGENT_SHARED: ['representing_agent', 'party_club_signatory', 'party_club_member'],
  RELEASING_AGENT_SHARED: ['representing_agent', 'party_club_signatory', 'party_club_member'],
  ALL_TRANSACTION_PARTIES: [
    'representing_agent',
    'party_individual',
    'party_guardian',
    'party_club_signatory',
    'party_club_member',
  ],
  T_AND_S_ONLY: ['trust_safety'],
});

/**
 * Both clubs hold `party_club_signatory`, so club-side classes are also checked against the viewer's side; without
 * this each club could read the other's private documents.
 */
const VISIBILITY_SIDE = nullProto({
  ENGAGING_CLUB_PRIVATE: 'engaging_entity',
  RELEASING_CLUB_PRIVATE: 'releasing_entity',
  ENGAGING_AGENT_SHARED: 'engaging_entity',
  RELEASING_AGENT_SHARED: 'releasing_entity',
});

/** `partyRole` is the viewer's side, for a club. */
export function canSeeVisibility(visibility, roles, partyRole = null) {
  if (typeof visibility !== 'string' || !Object.hasOwn(VISIBILITY_ROLES, visibility)) return false;
  const allowed = VISIBILITY_ROLES[visibility];
  if (!Array.isArray(roles) || !roles.some((r) => allowed.includes(r))) return false;
  const side = VISIBILITY_SIDE[visibility];
  if (!side) return true;
  if (roles.includes('representing_agent')) return true;
  return partyRole === side;
}

/** Narrower than what a viewer may read. */
export function uploadableVisibilities(roles, partyRole = null) {
  const out = [];
  for (const v of DOCUMENT_VISIBILITY) {
    if (v === 'T_AND_S_ONLY') continue;
    if (!canSeeVisibility(v, roles, partyRole)) continue;
    // The club-side classes belong to the club and agent lanes, not the player's.
    if (
      roles.includes('party_individual') &&
      !roles.includes('representing_agent') &&
      /CLUB|ENGAGING|RELEASING/.test(v) &&
      v !== 'ALL_TRANSACTION_PARTIES'
    )
      continue;
    out.push(v);
  }
  return out;
}

export const NOTE_VISIBILITY = Object.freeze(DOCUMENT_VISIBILITY.filter((v) => v !== 'T_AND_S_ONLY'));

// ------------------------------------------------------------------ compliance state

export const PENDING_REASONS = Object.freeze([
  'CONSENT_REQUIRED',
  'MANUAL_REVIEW',
  'INSUFFICIENT_DATA',
  'PROVIDER_UNAVAILABLE',
  'JURISDICTION_UNSUPPORTED',
  'FACET_NOT_VERIFIED',
  'PARTIES_NOT_CONFIRMED',
  'REPRESENTATION_MISSING',
]);
/** Refusals by the facet gate before the engine ran, so the snapshot names no evaluation row. */
export const COMPLIANCE_GATES = Object.freeze(['FACET_NOT_VERIFIED', 'JURISDICTION_UNSUPPORTED']);
export const STALENESS_REASONS = Object.freeze(['NO_SNAPSHOT', 'INPUTS_CHANGED', 'POLICY_CHANGED', 'EXPIRED']);
export const WITHDRAWN_REASONS = Object.freeze([
  'party_removed',
  'agent_withdrew',
  'subject_removed',
  'review_rejected',
]);

/**
 * A snapshot stores only the evaluation it names (or its gate), its pending reason, the party revision and licence
 * freshness; outcome, reasons and versions are read back from `evaluation` (null for a gate snapshot).
 */
export function snapshotView(tx, stored, evaluation) {
  if (!stored) return null;
  const gate = stored.gate ?? null;
  const outcome = gate ? null : (evaluation?.outcome ?? null);
  const reasonCodes = gate
    ? gate === 'JURISDICTION_UNSUPPORTED'
      ? ['POLICY_NOT_ENCODED']
      : []
    : [...new Set((evaluation?.reasons ?? []).map((r) => r.code))];
  const pendingReason = stored.pendingReason ?? null;
  const consents = gate ? [] : (evaluation?.consentsOutstanding ?? []);
  const state = {
    outcome,
    reasonCodes,
    pendingReason,
    blocked: pendingReason === null && outcome === 'PROHIBITED_CONFLICT',
    clear: pendingReason === null && outcome === 'CLEAR',
  };
  if (pendingReason === 'CONSENT_REQUIRED' && outcome === PERMITTED_WITH_CONSENT) state.consentsOutstanding = consents;
  return {
    evaluationId: gate ? `${tx.id}#gate` : stored.evaluationId,
    contextId: tx.contextId ?? null,
    evaluatedAt: stored.evaluatedAt,
    policyVersions: gate ? [] : (evaluation?.policyVersions ?? []),
    outcome,
    reasonCodes,
    pendingReason,
    blocked: state.blocked,
    clear: state.clear,
    consentRequirements: consents.map((c) => ({
      partyRole: c.partyRole,
      consentKind: c.consentKind,
      reasonCode: c.reasonCode,
    })),
    verificationFreshness: stored.verificationFreshness ?? null,
    partyRevision: stored.partyRevision,
    state,
  };
}

export function complianceStateFrom({
  outcome = null,
  gate = null,
  reasons = [],
  consentsOutstanding = [],
  representationCount = 0,
  partiesConfirmed = false,
}) {
  const codes = [...new Set((reasons ?? []).map((r) => (typeof r === 'string' ? r : r?.code)).filter(Boolean))];
  const base = { outcome: outcome ?? null, reasonCodes: codes, pendingReason: null, blocked: false, clear: false };
  if (gate) return { ...base, pendingReason: gate, blocked: false };
  if (!partiesConfirmed) return { ...base, pendingReason: 'PARTIES_NOT_CONFIRMED' };
  if (outcome === 'PROHIBITED_CONFLICT') return { ...base, blocked: true };
  if (outcome === PERMITTED_WITH_CONSENT) return { ...base, pendingReason: 'CONSENT_REQUIRED', consentsOutstanding };
  if (outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED') return { ...base, pendingReason: 'MANUAL_REVIEW' };
  if (outcome === 'INSUFFICIENT_DATA') return { ...base, pendingReason: 'INSUFFICIENT_DATA' };
  if (outcome !== 'CLEAR') return { ...base, pendingReason: 'INSUFFICIENT_DATA' };
  // With no representation recorded nobody has authority yet, so CLEAR is not a clearance.
  if (representationCount < 1) return { ...base, pendingReason: 'REPRESENTATION_MISSING' };
  return { ...base, clear: true };
}

export function statusForComplianceState(state) {
  if (!state) return null;
  if (state.blocked) return 'COMPLIANCE_BLOCKED';
  if (state.clear) return 'READY';
  // Not yet a compliance question: calling these COMPLIANCE_PENDING would tell a party compliance is outstanding
  // when nothing has been asked of it.
  if (state.pendingReason === 'PARTIES_NOT_CONFIRMED' || state.pendingReason === 'REPRESENTATION_MISSING')
    return 'PARTIES_CONFIRMED';
  return 'COMPLIANCE_PENDING';
}

// ------------------------------------------------------------------ snapshots

/** A hash of everything a compliance evaluation depended on: when it changes, the evaluation is stale by definition. */
export function partyRevisionOf({
  parties = [],
  agentUserId = null,
  representations = [],
  consents = [],
  facetStates = {},
  policyVersions = [],
  blockedSubjectIds = [],
  minorSubjectIds = [],
}) {
  return inputHashOf({
    parties: parties
      .filter((p) => p && !p.removed)
      .map((p) => `${p.partyRole}:${p.subjectKind}:${p.subjectId}:${p.confirmedAt ? 'c' : 'u'}`)
      .sort(),
    agentUserId,
    representations: representations
      .filter((r) => r && r.status !== 'withdrawn')
      .map((r) => `${r.agentUserId}:${r.partyRole}:${r.status}:${r.agreementId ?? ''}`)
      .sort(),
    consents: consents.map((k) => `${k.id}:${k.status}`).sort(),
    facetStates,
    policyVersions: [...policyVersions].sort(),
    blockedSubjectIds: [...blockedSubjectIds].sort(),
    minorSubjectIds: [...minorSubjectIds].sort(),
  });
}

/** The reason the snapshot is stale, or null. A missing snapshot is stale. */
export function snapshotStaleness(tx, currentPartyRevision, { now = Date.now(), maxAgeMs = null } = {}) {
  const snap = tx?.compliance ?? null;
  if (!snap || !snap.evaluationId) return 'NO_SNAPSHOT';
  if (snap.partyRevision !== currentPartyRevision) return 'INPUTS_CHANGED';
  if (tx.reEvaluationPending) return 'POLICY_CHANGED';
  if (maxAgeMs != null && typeof snap.evaluatedAt === 'number' && snap.evaluatedAt + maxAgeMs <= now) return 'EXPIRED';
  return null;
}

// ------------------------------------------------------------------ offer boundary

/** What the Offer workflow reads: a readiness boolean and its blockers. */
export function offerReadiness(tx, { complianceState = null, staleness = null } = {}) {
  const blockers = [];
  if (!tx) return { canStartOfferWorkflow: false, blockers: ['NO_TRANSACTION'], honest: OFFER_HONEST };
  if (!['READY', 'ACTIVE'].includes(tx.status)) blockers.push('TRANSACTION_NOT_READY');
  if (staleness) blockers.push('COMPLIANCE_SNAPSHOT_STALE');
  if (!complianceState?.clear) blockers.push('COMPLIANCE_NOT_CLEAR');
  if (!partiesOf(tx).some((p) => !p.removed && p.partyRole === 'individual' && p.confirmedAt))
    blockers.push('INDIVIDUAL_NOT_CONFIRMED');
  if (!partiesOf(tx).some((p) => !p.removed && p.partyRole === 'engaging_entity' && p.confirmedAt))
    blockers.push('ENGAGING_ENTITY_NOT_CONFIRMED');
  return { canStartOfferWorkflow: blockers.length === 0, blockers, honest: OFFER_HONEST };
}

const OFFER_HONEST =
  'Readiness means ScoutBox currently permits this workflow to proceed under the encoded rules. No offer exists, no offer can be created here, and nothing has been agreed, approved or signed.';

// ------------------------------------------------------------------ party model

export function requiredPartyRoles(type) {
  const roles = ['individual', 'engaging_entity'];
  if (RELEASING_PARTY_TYPES.includes(type)) roles.push('releasing_entity');
  return roles;
}

export function partiesConfirmed(tx) {
  if (!tx) return false;
  for (const role of requiredPartyRoles(tx.type)) {
    const p = partiesOf(tx).find((x) => x && !x.removed && x.partyRole === role);
    if (!p || !p.confirmedAt) return false;
  }
  return true;
}

export const partiesAwaitingConfirmation = (tx) =>
  requiredPartyRoles(tx?.type).filter((role) => {
    const p = partiesOf(tx).find((x) => x && !x.removed && x.partyRole === role);
    return !p || !p.confirmedAt;
  });

// ------------------------------------------------------------------ timeline

/**
 * `per_document` entries reach exactly the parties the document's own class admits: announcing a private document
 * to everyone would disclose what the class exists to hide.
 */
export const TIMELINE_AUDIENCES = Object.freeze([
  'all_parties',
  'agent_only',
  'player_and_agent',
  'club_side',
  'per_document',
  'audit_only',
]);

const ACTION_AUDIENCE = nullProto({
  transaction_created: 'all_parties',
  transaction_party_added: 'all_parties',
  transaction_party_removed: 'all_parties',
  transaction_party_confirmed: 'all_parties',
  transaction_status_changed: 'all_parties',
  transaction_held: 'all_parties',
  transaction_cancelled: 'all_parties',
  transaction_closed: 'all_parties',
  transaction_archived: 'all_parties',
  transaction_compliance_evaluated: 'all_parties',
  transaction_compliance_stale: 'all_parties',
  transaction_document_added: 'per_document',
  transaction_document_superseded: 'per_document',
  transaction_document_removed: 'per_document',
  transaction_message_linked: 'all_parties',
  transaction_terms_recorded: 'all_parties',
  // A representation is the agent's own regulated act.
  transaction_representation_attached: 'agent_only',
  transaction_representation_withdrawn: 'agent_only',
  transaction_consent_requested: 'player_and_agent',
  transaction_note_added: 'audit_only',
  transaction_evaluated_internal: 'audit_only',
  transaction_subject_tombstoned: 'audit_only',
});

export const timelineAudienceOf = (action) => ACTION_AUDIENCE[action] ?? 'audit_only';

/** A `per_document` entry with no class in `detail` is withheld. */
export function timelineVisible(audience, roles, partyRole = null, detail = null) {
  if (audience === 'audit_only') return false;
  if (!Array.isArray(roles) || !roles.length) return false;
  if (roles.includes('trust_safety')) return true;
  if (audience === 'per_document') {
    const v = typeof detail?.visibility === 'string' ? detail.visibility : null;
    return v ? canSeeVisibility(v, roles, partyRole) : false;
  }
  if (audience === 'all_parties') return true;
  if (audience === 'agent_only') return roles.includes('representing_agent');
  if (audience === 'player_and_agent')
    return (
      roles.includes('representing_agent') || roles.includes('party_individual') || roles.includes('party_guardian')
    );
  if (audience === 'club_side')
    return (
      roles.includes('party_club_signatory') ||
      roles.includes('party_club_member') ||
      (roles.includes('representing_agent') && partyRole !== null)
    );
  return false;
}

export function timelineFor(tx, roles, partyRole = null, { limit = 200 } = {}) {
  const out = [];
  for (const h of Array.isArray(tx?.history) ? tx.history : []) {
    const audience = timelineAudienceOf(h?.action);
    if (!timelineVisible(audience, roles, partyRole, h?.detail)) continue;
    out.push({
      id: h.id,
      at: h.at,
      action: h.action,
      audience,
      actor: actorLabel(h.by),
      detail: safeTimelineDetail(h.detail),
    });
  }
  return out.slice(-limit).reverse();
}

/** A role label, not an identity: no party learns which named person on another side acted. */
export function actorLabel(by) {
  if (!by) return null;
  if (by.kind === 'ts_reviewer') return { kind: 'trust_safety', label: 'Trust & Safety (attributed)' };
  if (by.kind === 'org' || by.kind === 'agent') return { kind: 'agent', label: 'Representing agent' };
  if (by.kind === 'club_user') return { kind: 'club', label: 'Club signatory' };
  if (by.kind === 'player') return { kind: 'player', label: 'Player' };
  if (by.kind === 'system') return { kind: 'system', label: by.name ?? 'ScoutBox' };
  return { kind: 'other', label: by.kind };
}

/** Codes, states and counts only: no prose, names or fees. */
function safeTimelineDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  for (const k of [
    'from',
    'to',
    'partyRole',
    'subjectKind',
    'status',
    'outcome',
    'pendingReason',
    'reasonCodes',
    'policyVersions',
    'documentType',
    'visibility',
    'staleness',
    'holdReasonCode',
    'version',
    'count',
  ]) {
    if (detail[k] !== undefined) out[k] = detail[k];
  }
  return Object.keys(out).length ? out : null;
}

// ------------------------------------------------------------------ hold / cancel reasons

/** Codes, so analytics can count them without reading prose. */
export const HOLD_REASON_CODES = Object.freeze([
  'awaiting_party_decision',
  'awaiting_document',
  'awaiting_regulatory_answer',
  'window_closed',
  'party_request',
  'other',
]);
export const CANCEL_REASON_CODES = Object.freeze([
  'party_withdrew',
  'terms_not_agreed',
  'window_closed',
  'compliance_not_cleared',
  'duplicate',
  'other',
]);
export const CLOSE_REASON_CODES = Object.freeze([
  'process_concluded',
  'proceeded_outside_scoutbox',
  'superseded',
  'other',
]);

// ------------------------------------------------------------------ limits

export const TRANSACTION_LIMITS = Object.freeze({
  parties: 4,
  note: 2000,
  label: 120,
  reason: 400,
  documents: 200,
  notes: 200,
  linkedThreads: 20,
  historyPage: 200,
  termsVersions: 50,
});
