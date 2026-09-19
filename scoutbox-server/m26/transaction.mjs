/**
 * M23 P5.6D — ScoutBox Agent Transaction Workspace: the pure layer.
 *
 * Everything here is a function over plain records and a clock. Nothing reads
 * `db`, nothing answers HTTP, nothing emits. The routes in ./index.mjs call
 * these and the acceptance suite exercises them directly, so a state
 * transition, a visibility decision or a staleness verdict can never differ
 * between a route and a test.
 *
 * What a ScoutBox transaction IS (mandate §2): a permissioned, auditable
 * multi-party workspace that identifies parties, tracks authority, enforces
 * platform permissions, attaches compliance snapshots, classifies documents,
 * references correspondence and records history.
 *
 * What it is NOT, and this module encodes the difference rather than asserting
 * it in prose:
 *
 *   - NOT a Recruitment Case (§3). A Case is one club's private internal
 *     workflow; `db.recruitmentCases` is never read or written here and a
 *     transaction cannot be created from one. The one-way link is P5.6E.
 *   - NOT an Offer (§4). There is no `offer_made`, `offer_accepted`,
 *     `offer_declined` or `signed` state in TRANSACTION_STATUSES, and
 *     `offerReadiness()` computes a READINESS — a boolean and its blockers —
 *     without creating anything. P6 owns Offer.
 *   - NOT a Signing (§5). No terminal state means "signed"; the neutral
 *     terminal is CLOSED, chosen over COMPLETED exactly because "completed"
 *     reads as a concluded transfer (§21).
 *   - NOT a negotiator (§37). Nothing in this module proposes, accepts or
 *     values a term. Terms exist as recorded data with a version history and
 *     no evaluation of them whatsoever.
 *
 * The frozen names this module must use, and does (P5.6A):
 *   `agentTransactions` and `transactionRepresentations` as store names
 *   (M23_P56A_AGENT_STORE_PROPOSAL.md §4, §5); `individual`,
 *   `engaging_entity`, `releasing_entity` as party roles and
 *   `employment_contract | transfer | loan | other_services` as types — both
 *   imported from the P5.6C conflict engine rather than re-declared, so a
 *   transaction can never name a party role or a type the engine would reject;
 *   the seven room roles of M23_P56A_AGENT_FINAL_ARCHITECTURE.md §8.
 */

import { inputHashOf, PARTY_ROLES, CONTEXT_TYPES, PERMITTED_WITH_CONSENT } from '../m25/conflict.mjs';

export { PARTY_ROLES, PERMITTED_WITH_CONSENT };

/**
 * Transaction types. The SAME four the P5.6A conflict-engine contract froze
 * and the P5.6C engine accepts, imported rather than copied: a fifth type
 * here would be a type the engine answers `TYPE_UNKNOWN → INSUFFICIENT_DATA`
 * for, which is a silent dead end rather than a feature.
 *
 * The P5.6D mandate §7 offers "permanent transfer", "employment / free agent"
 * and "renewal if within architecture scope" as *examples*, and says to defer
 * anything P5.6A/P5.6C did not freeze. `transfer` covers a permanent transfer,
 * `employment_contract` covers a free-agent engagement, and there is no
 * `renewal` type in any frozen document — renewal appears only as agreement
 * term language — so it is deferred, not invented.
 */
export const TRANSACTION_TYPES = CONTEXT_TYPES;

/** A releasing entity is meaningful only where the individual leaves someone. */
export const RELEASING_PARTY_TYPES = Object.freeze(['transfer', 'loan']);

/**
 * The state machine (mandate §11, §12). Ten states, no freeform strings, and
 * none of them is an offer or a signing.
 *
 *   DRAFT               the workspace exists; parties are named but not all
 *                       confirmed. No regulated progression, no compliance
 *                       claim, no private data crosses a party boundary (§13).
 *   PARTIES_CONFIRMED   every required party has been confirmed BY ITSELF —
 *                       the player by the player, a club by its recorded
 *                       signatory. Draft text entry is never confirmation (§14).
 *   COMPLIANCE_PENDING  the compliance layer cannot currently permit
 *                       progression and says WHY through `pendingReason`,
 *                       never as a generic pending (§15).
 *   COMPLIANCE_BLOCKED  an ACTIVE encoded rule prohibits the combination. A
 *                       reviewer cannot approve past it; only changed facts or
 *                       a new policy version produce a different answer (§16).
 *   READY               ScoutBox currently permits the workflow to proceed
 *                       under the encoded rules. NOT "legally valid", NOT
 *                       "FIFA approved", NOT "transfer approved" (§17).
 *   ACTIVE              the parties are using the workspace (§18).
 *   ON_HOLD             explicit hold with a reason; leaving it re-checks
 *                       compliance rather than resuming on trust (§19).
 *   CANCELLED           ended without conclusion; history preserved (§20).
 *   CLOSED              the neutral operational terminal (§21).
 *   ARCHIVED            a retention/visibility state, never a deletion (§22).
 */
export const TRANSACTION_STATUSES = Object.freeze([
  'DRAFT', 'PARTIES_CONFIRMED', 'COMPLIANCE_PENDING', 'COMPLIANCE_BLOCKED',
  'READY', 'ACTIVE', 'ON_HOLD', 'CANCELLED', 'CLOSED', 'ARCHIVED',
]);

/** States in which the workspace is still live: compliance is re-evaluated and parties may act. */
export const LIVE_STATUSES = Object.freeze(['DRAFT', 'PARTIES_CONFIRMED', 'COMPLIANCE_PENDING', 'COMPLIANCE_BLOCKED', 'READY', 'ACTIVE', 'ON_HOLD']);
/** States nothing can be written into. ARCHIVED is read-only for everyone including its owner. */
export const TERMINAL_STATUSES = Object.freeze(['CANCELLED', 'CLOSED', 'ARCHIVED']);

const nullProto = (o) => Object.freeze(Object.assign(Object.create(null), o));
/**
 * Defensive container accessors.
 *
 * A snapshot can hold a row that a partial write, a hand-edit or an older shape
 * left without its arrays. Before this, one such row made EVERY party's list
 * route answer 500 — a malformed record took the whole surface down rather than
 * being contained to itself (defect D8). A row with no parties belongs to
 * nobody, which is the safe reading as well as the tolerant one.
 */
const partiesOf = (tx) => (Array.isArray(tx?.parties) ? tx.parties : []);


/**
 * Transitions an ACTOR may request. Deliberately does NOT contain READY,
 * COMPLIANCE_PENDING or COMPLIANCE_BLOCKED: those three are the compliance
 * layer's answer, not anyone's request, so no request body — and no client,
 * however authorised — can write them. A caller who asks for READY is refused
 * by this map; a caller who asks for ACTIVE is refused by the compliance gate,
 * with the reason. Both are what adversarial cases 25 and 26 ("manual-review
 * transaction tries ACTIVE", "prohibited transaction tries ACTIVE") ask for.
 */
export const ACTOR_TRANSITIONS = nullProto({
  DRAFT: ['PARTIES_CONFIRMED', 'CANCELLED'],
  PARTIES_CONFIRMED: ['CANCELLED'],
  // ACTIVE is requestable from the two compliance states on purpose: the
  // request is then refused BY COMPLIANCE, with the real reason, instead of by
  // the transition map with a generic one. The gate requires `clear`, so the
  // safety is identical and the answer is more honest.
  COMPLIANCE_PENDING: ['ACTIVE', 'CANCELLED'],
  COMPLIANCE_BLOCKED: ['ACTIVE', 'CANCELLED'],
  READY: ['ACTIVE', 'ON_HOLD', 'CANCELLED'],
  ACTIVE: ['ON_HOLD', 'CLOSED', 'CANCELLED'],
  ON_HOLD: ['ACTIVE', 'CLOSED', 'CANCELLED'],
  CANCELLED: ['ARCHIVED'],
  CLOSED: ['ARCHIVED'],
  ARCHIVED: [],
});

/**
 * Transitions the COMPLIANCE layer may make when an evaluation lands. Every
 * one of them is reachable only from a state where the parties are confirmed:
 * a DRAFT is never told it is READY, because a draft makes no compliance
 * claim at all (§13).
 */
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

export const actorTransitionAllowed = (from, to) =>
  typeof from === 'string' && Object.hasOwn(ACTOR_TRANSITIONS, from) && ACTOR_TRANSITIONS[from].includes(to);
export const complianceTransitionAllowed = (from, to) =>
  typeof from === 'string' && Object.hasOwn(COMPLIANCE_TRANSITIONS, from) && COMPLIANCE_TRANSITIONS[from].includes(to);

/** Every status a transition map can reach, for the state-machine document and its test. */
export const ALL_TRANSITIONS = Object.freeze(
  TRANSACTION_STATUSES.map((from) => ({
    from,
    byActor: ACTOR_TRANSITIONS[from] ?? [],
    byCompliance: COMPLIANCE_TRANSITIONS[from] ?? [],
  })),
);

// ------------------------------------------------------------------ room roles

/**
 * The seven room roles frozen in M23_P56A_AGENT_FINAL_ARCHITECTURE.md §8.
 * They are the Agent module's own, deliberately NOT M17's Recruitment Room
 * roles: a Recruitment Room is one club's internal space and its roles carry
 * club-internal meaning that must not leak into a multi-party workspace.
 *
 * `party_guardian` exists and is never granted in this build: no minor
 * transaction pathway is production-enabled (§59), so the architecture is
 * preserved without a live surface (§60).
 */
export const ROOM_ROLES = Object.freeze([
  'representing_agent', 'party_individual', 'party_guardian',
  'party_club_signatory', 'party_club_member', 'agency_admin_observer', 'trust_safety',
]);

/**
 * The room roles a viewer holds in one transaction. Pure over records the
 * caller already resolved through their own gates: the caller passes what the
 * SERVER derived (is this org a party? is this user a recorded signatory?),
 * never what a request body claimed (§67).
 */
export function roomRolesFor(tx, viewer) {
  const roles = [];
  if (!tx || !viewer) return roles;
  const live = (p) => p && !p.removed;
  const parties = partiesOf(tx);
  if (viewer.kind === 'ts_reviewer') return ['trust_safety'];
  if (viewer.kind === 'player') {
    if (parties.some((p) => live(p) && p.subjectKind === 'player' && p.subjectId === viewer.playerId)) roles.push('party_individual');
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

/** The party role a club viewer occupies in this transaction, or null. */
export { partiesOf };

export const clubPartyRoleOf = (tx, orgId) =>
  partiesOf(tx).find((p) => p && !p.removed && p.subjectKind === 'club' && p.subjectId === orgId)?.partyRole ?? null;

// ------------------------------------------------------------------ documents

/**
 * Document types (§31). Each is a CLASSIFICATION of a record that lives in the
 * canonical evidence vault or nowhere at all — this module stores no bytes and
 * mints no URL, because ScoutBox already has exactly one upload path and a
 * second one would be a second security surface (§82).
 *
 * `employment_contract_draft` and `term_sheet_draft` are drafts and say so in
 * their names: nothing here is signed, and `signedAt` is recordable only when
 * objectively known from the underlying evidence (§32).
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
 * Explicit document visibility classes (§33). A class names PARTIES AND ROLES,
 * never a list of user ids a client supplied: the server resolves the caller's
 * room roles at read time and asks this table, so a document cannot be made
 * visible to someone by writing their id into a field.
 *
 * `T_AND_S_ONLY` is reachable by no party at all — not even the uploader —
 * which is why `canUploadVisibility` refuses it: a party cannot file something
 * into a Trust & Safety lane and a reviewer's evidence is never a party's to
 * classify.
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
 * Which room roles each visibility class admits. Read as: "a viewer holding
 * any of these roles may see a document of this class".
 *
 * Two deliberate absences:
 *   - `AGENT_PRIVATE` does NOT admit `agency_admin_observer`. A same-agency
 *     colleague is one agent for conflicts and a separate person for data
 *     (P5.6A privacy matrix, DR-26); the agency administrator who can see the
 *     transaction exists cannot read the representing agent's private file.
 *   - no class admits `trust_safety` except `T_AND_S_ONLY`. A reviewer reads
 *     states and ids, not the parties' documents; their read surface is
 *     `/ts/transactions` and it carries no document content.
 */
const VISIBILITY_ROLES = nullProto({
  AGENT_PRIVATE: ['representing_agent'],
  PLAYER_PRIVATE: ['party_individual', 'party_guardian'],
  ENGAGING_CLUB_PRIVATE: ['party_club_signatory', 'party_club_member'],
  RELEASING_CLUB_PRIVATE: ['party_club_signatory', 'party_club_member'],
  PLAYER_AGENT_SHARED: ['representing_agent', 'party_individual', 'party_guardian'],
  ENGAGING_AGENT_SHARED: ['representing_agent', 'party_club_signatory', 'party_club_member'],
  RELEASING_AGENT_SHARED: ['representing_agent', 'party_club_signatory', 'party_club_member'],
  ALL_TRANSACTION_PARTIES: ['representing_agent', 'party_individual', 'party_guardian', 'party_club_signatory', 'party_club_member'],
  T_AND_S_ONLY: ['trust_safety'],
});

/**
 * The club-side classes are side-specific, and a role name alone cannot tell
 * the engaging club from the releasing one — both hold `party_club_signatory`.
 * So the caller passes the viewer's own party role and the class is checked
 * against the SIDE as well as the role. Without this, adversarial cases 7 and
 * 8 (each club reading the other's private document) would pass the role test.
 */
const VISIBILITY_SIDE = nullProto({
  ENGAGING_CLUB_PRIVATE: 'engaging_entity',
  RELEASING_CLUB_PRIVATE: 'releasing_entity',
  ENGAGING_AGENT_SHARED: 'engaging_entity',
  RELEASING_AGENT_SHARED: 'releasing_entity',
});

/**
 * May a viewer holding `roles` (and, for a club, occupying `partyRole`) see a
 * document classified `visibility`? Unknown class → false. Fails closed.
 */
export function canSeeVisibility(visibility, roles, partyRole = null) {
  if (typeof visibility !== 'string' || !Object.hasOwn(VISIBILITY_ROLES, visibility)) return false;
  const allowed = VISIBILITY_ROLES[visibility];
  if (!Array.isArray(roles) || !roles.some((r) => allowed.includes(r))) return false;
  const side = VISIBILITY_SIDE[visibility];
  if (!side) return true;
  // A club-side class is readable by that side's club and by the representing
  // agent; a club sitting on the other side is refused even though it holds
  // the same role name.
  if (roles.includes('representing_agent')) return true;
  return partyRole === side;
}

/**
 * Which classes a viewer may CREATE. Narrower than what they may read: a
 * viewer may not file a document into a lane they do not sit in, and nobody
 * may write `T_AND_S_ONLY`.
 */
export function uploadableVisibilities(roles, partyRole = null) {
  const out = [];
  for (const v of DOCUMENT_VISIBILITY) {
    if (v === 'T_AND_S_ONLY') continue;
    if (!canSeeVisibility(v, roles, partyRole)) continue;
    // A player may not classify something as shared with a club: the club-side
    // classes belong to the club lane and the agent lane.
    if (roles.includes('party_individual') && !roles.includes('representing_agent') && /CLUB|ENGAGING|RELEASING/.test(v) && v !== 'ALL_TRANSACTION_PARTIES') continue;
    out.push(v);
  }
  return out;
}

/** Note visibility reuses the document classes, minus the Trust & Safety lane. */
export const NOTE_VISIBILITY = Object.freeze(DOCUMENT_VISIBILITY.filter((v) => v !== 'T_AND_S_ONLY'));

// ------------------------------------------------------------------ compliance state

/**
 * The compliance layer's answer, turned into an operational state and a REASON
 * (§15 — never a generic pending).
 *
 * `outcome` is the P5.6C conflict engine's verdict; `gate` carries the
 * non-conflict refusals the transaction's own pipeline can hit before the
 * engine is consulted (a missing verified facet, an unsupported jurisdiction,
 * a verification source that is down). A blocked party — safeguarding — is
 * handled before any of this, because a block ends the question rather than
 * answering it (§61).
 */
export const PENDING_REASONS = Object.freeze([
  'CONSENT_REQUIRED', 'MANUAL_REVIEW', 'INSUFFICIENT_DATA', 'PROVIDER_UNAVAILABLE',
  'JURISDICTION_UNSUPPORTED', 'FACET_NOT_VERIFIED', 'PARTIES_NOT_CONFIRMED', 'REPRESENTATION_MISSING',
]);

export function complianceStateFrom({ outcome = null, gate = null, reasons = [], consentsOutstanding = [], representationCount = 0, partiesConfirmed = false }) {
  const codes = [...new Set((reasons ?? []).map((r) => (typeof r === 'string' ? r : r?.code)).filter(Boolean))];
  const base = { outcome: outcome ?? null, reasonCodes: codes, pendingReason: null, blocked: false, clear: false };
  if (gate) return { ...base, pendingReason: gate, blocked: false };
  if (!partiesConfirmed) return { ...base, pendingReason: 'PARTIES_NOT_CONFIRMED' };
  if (outcome === 'PROHIBITED_CONFLICT') return { ...base, blocked: true };
  if (outcome === PERMITTED_WITH_CONSENT) return { ...base, pendingReason: 'CONSENT_REQUIRED', consentsOutstanding };
  if (outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED') return { ...base, pendingReason: 'MANUAL_REVIEW' };
  if (outcome === 'INSUFFICIENT_DATA') return { ...base, pendingReason: 'INSUFFICIENT_DATA' };
  if (outcome !== 'CLEAR') return { ...base, pendingReason: 'INSUFFICIENT_DATA' };
  // A CLEAR engine answer with no representation recorded is not a clearance
  // to proceed: nobody has authority in this transaction yet.
  if (representationCount < 1) return { ...base, pendingReason: 'REPRESENTATION_MISSING' };
  return { ...base, clear: true };
}

/** The status a compliance state implies, or null where the compliance layer has nothing to say. */
export function statusForComplianceState(state) {
  if (!state) return null;
  if (state.blocked) return 'COMPLIANCE_BLOCKED';
  if (state.clear) return 'READY';
  // Neither of these is a compliance question yet: the parties are not all
  // confirmed, or nobody has claimed authority. Calling them COMPLIANCE_PENDING
  // would make PARTIES_CONFIRMED a state no transaction ever rests in, and
  // would tell a party that compliance is outstanding when nothing has been
  // asked of it.
  if (state.pendingReason === 'PARTIES_NOT_CONFIRMED' || state.pendingReason === 'REPRESENTATION_MISSING') return 'PARTIES_CONFIRMED';
  return 'COMPLIANCE_PENDING';
}

// ------------------------------------------------------------------ snapshots

/**
 * The party/authority revision: a hash of everything a compliance evaluation
 * depended on. When it changes, the evaluation that was made under the old one
 * is STALE by definition rather than by a heuristic (§27).
 *
 * It covers, exactly, the eight things §27 lists: the parties, the agent, the
 * representations, the consents, the licence facets, the policy versions, the
 * safeguarding state and the minor state. `inputHashOf` is the conflict
 * engine's own canonical hash, reused so the two never disagree about what
 * "the same inputs" means.
 */
export function partyRevisionOf({ parties = [], agentUserId = null, representations = [], consents = [], facetStates = {}, policyVersions = [], blockedSubjectIds = [], minorSubjectIds = [] }) {
  return inputHashOf({
    parties: parties.filter((p) => p && !p.removed).map((p) => `${p.partyRole}:${p.subjectKind}:${p.subjectId}:${p.confirmedAt ? 'c' : 'u'}`).sort(),
    agentUserId,
    representations: representations.filter((r) => r && r.status !== 'withdrawn').map((r) => `${r.agentUserId}:${r.partyRole}:${r.status}:${r.agreementId ?? ''}`).sort(),
    consents: consents.map((k) => `${k.id}:${k.status}`).sort(),
    facetStates,
    policyVersions: [...policyVersions].sort(),
    blockedSubjectIds: [...blockedSubjectIds].sort(),
    minorSubjectIds: [...minorSubjectIds].sort(),
  });
}

/**
 * Is the snapshot on a transaction still the one the current facts produce?
 * Returns the reason it is stale, or null. A missing snapshot is stale — the
 * absence of an evaluation is never a clearance.
 */
export function snapshotStaleness(tx, currentPartyRevision, { now = Date.now(), maxAgeMs = null } = {}) {
  const snap = tx?.compliance ?? null;
  if (!snap || !snap.evaluationId) return 'NO_SNAPSHOT';
  if (snap.partyRevision !== currentPartyRevision) return 'INPUTS_CHANGED';
  if (tx.reEvaluationPending) return 'POLICY_CHANGED';
  if (maxAgeMs != null && typeof snap.evaluatedAt === 'number' && snap.evaluatedAt + maxAgeMs <= now) return 'EXPIRED';
  return null;
}

// ------------------------------------------------------------------ offer boundary

/**
 * The ONE seam a future Offer Workflow needs (§53, §54): a readiness boolean
 * and its blockers. It creates nothing, writes nothing and transitions
 * nothing; the caller exposes it read-only.
 *
 * P5.6A DR-38 reserves a `terms` tab and a `transactionTerms` record shape and
 * no Offer object, so readiness is computed from the transaction's own state
 * and never from an offer that does not exist.
 */
export function offerReadiness(tx, { complianceState = null, staleness = null } = {}) {
  const blockers = [];
  if (!tx) return { canStartOfferWorkflow: false, blockers: ['NO_TRANSACTION'], honest: OFFER_HONEST };
  if (!['READY', 'ACTIVE'].includes(tx.status)) blockers.push('TRANSACTION_NOT_READY');
  if (staleness) blockers.push('COMPLIANCE_SNAPSHOT_STALE');
  if (!complianceState?.clear) blockers.push('COMPLIANCE_NOT_CLEAR');
  if (!partiesOf(tx).some((p) => !p.removed && p.partyRole === 'individual' && p.confirmedAt)) blockers.push('INDIVIDUAL_NOT_CONFIRMED');
  if (!partiesOf(tx).some((p) => !p.removed && p.partyRole === 'engaging_entity' && p.confirmedAt)) blockers.push('ENGAGING_ENTITY_NOT_CONFIRMED');
  return { canStartOfferWorkflow: blockers.length === 0, blockers, honest: OFFER_HONEST };
}

const OFFER_HONEST = 'Readiness means ScoutBox currently permits this workflow to proceed under the encoded rules. No offer exists, no offer can be created here, and nothing has been agreed, approved or signed.';

// ------------------------------------------------------------------ party model

/** Which party roles a transaction of this type requires before it can be party-confirmed (§14). */
export function requiredPartyRoles(type) {
  const roles = ['individual', 'engaging_entity'];
  if (RELEASING_PARTY_TYPES.includes(type)) roles.push('releasing_entity');
  return roles;
}

/** Are all required parties present, unremoved and confirmed by their own side? */
export function partiesConfirmed(tx) {
  if (!tx) return false;
  for (const role of requiredPartyRoles(tx.type)) {
    const p = partiesOf(tx).find((x) => x && !x.removed && x.partyRole === role);
    if (!p || !p.confirmedAt) return false;
  }
  return true;
}

/** The party roles still waiting for their own confirmation. */
export const partiesAwaitingConfirmation = (tx) =>
  requiredPartyRoles(tx?.type).filter((role) => {
    const p = partiesOf(tx).find((x) => x && !x.removed && x.partyRole === role);
    return !p || !p.confirmedAt;
  });

// ------------------------------------------------------------------ timeline

/**
 * Audience tags for timeline entries (§39). A history action carries the
 * audience it may reach; a viewer's timeline is the history filtered by the
 * roles they hold. `audit_only` never reaches any party's timeline — that is
 * what keeps the platform audit distinct from the user-visible timeline (§40).
 */
export const TIMELINE_AUDIENCES = Object.freeze(['all_parties', 'agent_only', 'player_and_agent', 'club_side', 'audit_only']);

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
  transaction_document_added: 'all_parties',
  transaction_document_superseded: 'all_parties',
  transaction_document_removed: 'all_parties',
  transaction_message_linked: 'all_parties',
  transaction_terms_recorded: 'all_parties',
  // The agent's own lane: a representation is the agent's regulated act and a
  // colleague's or a club's timeline is not where it belongs.
  transaction_representation_attached: 'agent_only',
  transaction_representation_withdrawn: 'agent_only',
  transaction_consent_requested: 'player_and_agent',
  // Operational detail that belongs in the audit and in nobody's timeline.
  transaction_note_added: 'audit_only',
  transaction_evaluated_internal: 'audit_only',
  transaction_subject_tombstoned: 'audit_only',
});

export const timelineAudienceOf = (action) => ACTION_AUDIENCE[action] ?? 'audit_only';

/** Does a viewer holding `roles` receive a timeline entry with this audience? */
export function timelineVisible(audience, roles, partyRole = null) {
  if (audience === 'audit_only') return false;
  if (!Array.isArray(roles) || !roles.length) return false;
  if (roles.includes('trust_safety')) return true;
  if (audience === 'all_parties') return true;
  if (audience === 'agent_only') return roles.includes('representing_agent');
  if (audience === 'player_and_agent') return roles.includes('representing_agent') || roles.includes('party_individual') || roles.includes('party_guardian');
  if (audience === 'club_side') return roles.includes('party_club_signatory') || roles.includes('party_club_member') || (roles.includes('representing_agent') && partyRole !== null);
  return false;
}

/** Build one viewer's timeline from a transaction's append-only history. */
export function timelineFor(tx, roles, partyRole = null, { limit = 200 } = {}) {
  const out = [];
  for (const h of Array.isArray(tx?.history) ? tx.history : []) {
    const audience = timelineAudienceOf(h?.action);
    if (!timelineVisible(audience, roles, partyRole)) continue;
    out.push({ id: h.id, at: h.at, action: h.action, audience, actor: actorLabel(h.by), detail: safeTimelineDetail(h.detail) });
  }
  return out.slice(-limit).reverse();
}

/**
 * Who did it, as a LABEL rather than an identity. A club never learns which
 * named person at the agency acted, a player never learns a club user's name,
 * and a reviewer appears as the attributed role — the same wording the P5.6C
 * audit uses, for the same reason.
 */
export function actorLabel(by) {
  if (!by) return null;
  if (by.kind === 'ts_reviewer') return { kind: 'trust_safety', label: 'Trust & Safety (attributed)' };
  if (by.kind === 'org' || by.kind === 'agent') return { kind: 'agent', label: 'Representing agent' };
  if (by.kind === 'club_user') return { kind: 'club', label: 'Club signatory' };
  if (by.kind === 'player') return { kind: 'player', label: 'Player' };
  if (by.kind === 'system') return { kind: 'system', label: by.name ?? 'ScoutBox' };
  return { kind: 'other', label: by.kind };
}

/** Timeline detail is codes, states and counts. Never prose, never a name, never a fee. */
function safeTimelineDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  for (const k of ['from', 'to', 'partyRole', 'subjectKind', 'status', 'outcome', 'pendingReason', 'reasonCodes', 'policyVersions', 'documentType', 'visibility', 'staleness', 'holdReasonCode', 'version', 'count']) {
    if (detail[k] !== undefined) out[k] = detail[k];
  }
  return Object.keys(out).length ? out : null;
}

// ------------------------------------------------------------------ hold / cancel reasons

/** Hold and cancellation reasons are CODES, so analytics can count them without reading prose (§19, §76). */
export const HOLD_REASON_CODES = Object.freeze([
  'awaiting_party_decision', 'awaiting_document', 'awaiting_regulatory_answer', 'window_closed', 'party_request', 'other',
]);
export const CANCEL_REASON_CODES = Object.freeze([
  'party_withdrew', 'terms_not_agreed', 'window_closed', 'compliance_not_cleared', 'duplicate', 'other',
]);
export const CLOSE_REASON_CODES = Object.freeze([
  'process_concluded', 'proceeded_outside_scoutbox', 'superseded', 'other',
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
