// M23 P5.6E — the ONE cross-app integration authorization layer.
//
// §47: "Do not implement five app-specific copies of 'can Agent see this?'".
// Every integration seam — the Player's My Agent projection, the Club's Agent
// presence badge, Contact routing, Trial visibility, an opportunity share, a
// Passport projection, an evidence projection — asks THIS module, and this
// module is pure: it takes facts and returns a decision with a reason code.
// Nothing here reads the database, emits an event or writes a row.
//
// Two rules shape the whole file.
//
//   1. The canonical basis is the ONLY basis. A decision starts from
//      `agentClientBasis`, which is `agreementGrantsAccess` — a named licensed
//      individual on an active, client-confirmed, unexpired agreement. A legacy
//      M13 F10 row names no individual and therefore can never produce a basis
//      (see M23_P56E_REPRESENTATION_SEAM_AUDIT.md).
//
//   2. Every surface fails closed. An unknown surface, a missing fact, a
//      malformed agreement and an unrecognised scope all deny. A decision is
//      never "allowed because nothing said no".
//
// The rule stack, in the order a surface applies it, is fixed and named
// (`RULE_ORDER`) so a reviewer can see that no surface skips a step.

import {
  SCOPES, effectiveAgreementStatus, agreementGrantsAccess, normaliseScope,
  DISCLOSURE_KEYS, DISCLOSURE_DEFAULT, normaliseDisclosure,
} from '../m24/shared.mjs';

const nullProto = (o) => Object.freeze(Object.assign(Object.create(null), o));

/**
 * The integration surfaces. One entry per question another app can ask, each
 * naming the scopes it needs and whether it is a REGULATED action (one that
 * needs a current licence and, where the surface says so, a compliance answer)
 * or a READ of a projection.
 *
 * `scopes: null` means the surface does not depend on the agreement's scope —
 * knowing who represents the client is enough. `scopes: [...]` means at least
 * one of them must be on the agreement.
 */
export const SURFACES = nullProto({
  // The agent reading their own client's private record. P5.6B's own lane; here
  // so cross-app callers have one predicate rather than re-deriving it.
  client_private: { regulated: false, scopes: null, adultOnly: true },
  // The identity/football basics a represented client's agent may see without
  // any further share. Deliberately narrow (§10).
  passport_basic: { regulated: false, scopes: null, adultOnly: true },
  // Anything beyond the basics needs an explicit, separate player share (§11).
  passport_shared: { regulated: false, scopes: null, adultOnly: true, needsShare: true },
  // Evidence the player intentionally shared (§74). Never raw Box Cam.
  evidence_shared: { regulated: false, scopes: null, adultOnly: true, needsShare: true },
  // Being a routable party on a canonical Contact (§20–§24).
  contact_participation: { regulated: true, scopes: ['employment', 'transfer'], adultOnly: true, needsDisclosure: true },
  // Seeing that a Trial exists and its scheduling, never its assessment (§26–§29).
  trial_projection: { regulated: false, scopes: ['employment', 'transfer'], adultOnly: true, needsDisclosure: true },
  // Coordinating a Trial where scope allows (§28). Never confirming for the player.
  trial_coordination: { regulated: true, scopes: ['employment', 'transfer'], adultOnly: true, needsDisclosure: true },
  // Sharing an opportunity with a represented client (§18).
  opportunity_share: { regulated: true, scopes: ['employment', 'transfer'], adultOnly: true },
  // Opening a transaction for a client. P5.6D owns the rest of the decision.
  transaction_initiation: { regulated: true, scopes: ['employment', 'transfer'], adultOnly: true },
  // The Club-facing "represented by" badge. Asked about a PLAYER, answered from
  // the player's own disclosure choice — not from the agent's wish to be seen.
  club_agent_presence: { regulated: false, scopes: null, adultOnly: true, needsDisclosure: true },
});

export const SURFACE_NAMES = Object.freeze(Object.keys(SURFACES));

/**
 * The order in which a surface applies the rules. Every deny carries the code
 * of the FIRST rule that refused, so a refusal is explainable without being an
 * oracle: the codes name a category, never a party.
 */
export const RULE_ORDER = Object.freeze([
  'SURFACE_KNOWN', 'BASIS', 'SUBJECT_PRESENT', 'ADULT', 'MINOR_PATHWAY',
  'BLOCK', 'SCOPE', 'DISCLOSURE', 'SHARE', 'LICENCE', 'COMPLIANCE',
]);

/** Reason codes. One meaning each (§88) — no surface invents its own wording. */
export const DENY_CODES = Object.freeze([
  'SURFACE_UNKNOWN',           // fail closed on an unrecognised surface
  'NO_REPRESENTATION',         // no canonical basis at all
  'REPRESENTATION_NOT_ACTIVE', // a basis existed once; its status is not active now
  'REPRESENTATION_AMBIGUOUS',  // two active agents and nothing to choose between them
  'SUBJECT_UNAVAILABLE',       // removed, tombstoned or not resolvable
  'MINOR_PATHWAY_DISABLED',    // the client is a regulatory minor and the pathway is closed
  'BLOCKED',                   // canonical safety state
  'SCOPE_INSUFFICIENT',        // the agreement does not carry a scope this surface needs
  'DISCLOSURE_WITHHELD',       // the client has not agreed to this being visible/routed
  'SHARE_REQUIRED',            // needs an explicit share that does not exist
  'LICENCE_NOT_CURRENT',       // a regulated action with a stale or unverified facet
  'COMPLIANCE_NOT_CLEAR',      // the compliance layer has not permitted this
]);

const deny = (code, rule) => Object.freeze({ allowed: false, code, rule, basis: null });
const allow = (basis, surface) => Object.freeze({ allowed: true, code: null, rule: null, basis, surface });

/**
 * The canonical basis: which agreement, if any, makes this agent this player's
 * representative right now.
 *
 * Returns `{ ok, agentUserId, agreementId, scope, agencyOrgId, status }`. `ok` is
 * true only for a basis that `agreementGrantsAccess` accepts. When one or more
 * agreements exist but none is active, `status` names the most informative
 * non-active state so a caller can say "not active" rather than "none" — to the
 * AGENT, who already knows the relationship exists. It is never returned to a
 * third party.
 *
 * `agentUserId` is part of the basis and not merely an input echoed back: a
 * routing snapshot, a club presence badge and an agent's own read all need to
 * name the individual the agreement names, and a basis that omitted it made the
 * caller re-derive it — which is exactly how a caller ends up recording `null`
 * where a person should be.
 */
export function agentClientBasis({ agreements = [], agentUserId = null, clientId = null, now = Date.now() } = {}) {
  const none = (status = null) => ({ ok: false, agentUserId: null, agreementId: null, scope: [], agencyOrgId: null, status });
  if (typeof agentUserId !== 'string' || !agentUserId || typeof clientId !== 'string' || !clientId) return none();
  let fallback = null;
  for (const a of agreements) {
    if (!a || a.clientId !== clientId) continue;
    if (a.agentUserId !== agentUserId) continue;
    if (agreementGrantsAccess(a, agentUserId, now)) {
      return {
        ok: true,
        agentUserId: a.agentUserId,
        agreementId: a.id,
        scope: normaliseScope(a.scope),
        agencyOrgId: a.agencyOrgId ?? null,
        status: 'active',
        isRegulatoryMinor: a.isRegulatoryMinor === true,
      };
    }
    // Remember the most decision-relevant non-active state for the agent's own
    // reading. A dispute outranks an expiry outranks anything else.
    const st = effectiveAgreementStatus(a, now);
    const rank = st === 'disputed' ? 3 : st === 'expired' ? 2 : 1;
    if (!fallback || rank > fallback.rank) fallback = { rank, status: st };
  }
  return none(fallback?.status ?? null);
}

/**
 * THE decision. Every integration seam calls this and obeys the answer.
 *
 * Facts, all resolved by the CALLER from canonical sources and never from a
 * request body:
 *   surface          one of SURFACE_NAMES
 *   basis            the result of agentClientBasis
 *   subjectPresent   the client record exists and is not tombstoned
 *   isAdult          the client is at or above the age of majority
 *   minorPathwayOpen whether the encoded minor pathway is production-enabled
 *   blocked          canonical block between the parties
 *   disclosure       the client's own choice for this surface (see DISCLOSURE_DEFAULT)
 *   shared           an explicit share exists for a surface that needs one
 *   licenceCurrent   the agent's required facets are verified and fresh
 *   complianceClear  the compliance layer's CURRENT answer, where the surface is regulated
 */
export function agentSurfaceDecision({
  surface,
  basis = null,
  subjectPresent = false,
  isAdult = false,
  minorPathwayOpen = false,
  blocked = false,
  disclosure = null,
  shared = false,
  licenceCurrent = false,
  complianceClear = null,
} = {}) {
  const spec = typeof surface === 'string' && Object.hasOwn(SURFACES, surface) ? SURFACES[surface] : null;
  if (!spec) return deny('SURFACE_UNKNOWN', 'SURFACE_KNOWN');

  if (!basis || basis.ok !== true) {
    return deny(basis?.status ? 'REPRESENTATION_NOT_ACTIVE' : 'NO_REPRESENTATION', 'BASIS');
  }
  if (subjectPresent !== true) return deny('SUBJECT_UNAVAILABLE', 'SUBJECT_PRESENT');

  // Adulthood, then the minor pathway. A regulatory minor is refused unless the
  // encoded pathway is production-enabled — and it is not, so this fails closed
  // for every surface (§56/§57).
  if (spec.adultOnly && isAdult !== true) {
    if (!minorPathwayOpen) return deny('MINOR_PATHWAY_DISABLED', 'MINOR_PATHWAY');
  }
  if (basis.isRegulatoryMinor === true && !minorPathwayOpen) {
    return deny('MINOR_PATHWAY_DISABLED', 'MINOR_PATHWAY');
  }

  // Safety outranks every convenience, and a compliance answer never overrides
  // it (§55).
  if (blocked === true) return deny('BLOCKED', 'BLOCK');

  if (Array.isArray(spec.scopes)) {
    const have = Array.isArray(basis.scope) ? basis.scope : [];
    if (!spec.scopes.some((s) => have.includes(s))) return deny('SCOPE_INSUFFICIENT', 'SCOPE');
  }

  // The client's own choice. `null` is NOT consent: a surface that needs a
  // disclosure and has no recorded answer is withheld, so silence never becomes
  // permission.
  if (spec.needsDisclosure && disclosure !== true) return deny('DISCLOSURE_WITHHELD', 'DISCLOSURE');
  if (spec.needsShare && shared !== true) return deny('SHARE_REQUIRED', 'SHARE');

  if (spec.regulated) {
    if (licenceCurrent !== true) return deny('LICENCE_NOT_CURRENT', 'LICENCE');
    // A regulated surface that names a compliance requirement must be given an
    // answer. `null` means "not evaluated", which is not clear.
    if (complianceClear === false || complianceClear === null) {
      if (complianceClear === null && spec.complianceOptional === true) return allow(basis, surface);
      return deny('COMPLIANCE_NOT_CLEAR', 'COMPLIANCE');
    }
  }
  return allow(basis, surface);
}

/**
 * The client's disclosure choices are a FIELD OF THE AGREEMENT, so they are
 * defined with the agreement (`m24/shared.mjs`) and re-exported here: this layer
 * is where they are read as permissions, not where they are stored. Each
 * defaults to false — §21 says do not automatically replace the player with the
 * agent, and §15 says a club does not get agent data merely because the player
 * exists, so silence is never permission.
 */
export { DISCLOSURE_KEYS, DISCLOSURE_DEFAULT, normaliseDisclosure };

/** Which disclosure key a surface reads. A surface with no key needs none. */
export const SURFACE_DISCLOSURE = nullProto({
  contact_participation: 'contactRouting',
  trial_projection: 'trialVisibility',
  trial_coordination: 'trialVisibility',
  club_agent_presence: 'clubPresence',
});

/**
 * Which regulated action each regulated surface is, in the P5.6C policy engine's
 * vocabulary (`POLICY_ACTIONS`). A surface that is not regulated has no action
 * and asks the compliance layer nothing.
 */
export const POLICY_ACTION_FOR_SURFACE = nullProto({
  contact_participation: 'approach_adult',
  trial_coordination: 'approach_adult',
  opportunity_share: 'approach_adult',
  transaction_initiation: 'declare_representation',
});

/**
 * Contact routing (§21). Given the canonical recipient the P3 resolver produced
 * and the agent decision, say who is validly routable NOW.
 *
 * `mode` is what the club chose and is honoured only where it is permitted.
 *
 * THERE IS NO `agent_only`. A club may ask for the player alone or for the
 * player AND the agent; it may not ask for the agent INSTEAD of the player.
 * §21 says do not automatically replace the player with the agent, and a mode
 * that removed them would do exactly that — the player whose ScoutBox Inbox the
 * message lands in would never learn a club had approached them, and an
 * intercepted approach is precisely the "broader authority than the current
 * relationship permits" this milestone exists to prevent. The player is
 * therefore always a target; an agent is added BESIDE them, or not at all.
 */
export const CONTACT_ROUTING_MODES = Object.freeze(['player_only', 'both']);

export function contactRouting({ recipient = null, agentDecision = null, requestedMode = 'player_only' } = {}) {
  if (!recipient) return { ok: false, error: 'CONTACT_RECIPIENT_UNAVAILABLE' };
  const mode = CONTACT_ROUTING_MODES.includes(requestedMode) ? requestedMode : 'player_only';
  const agentOk = agentDecision?.allowed === true;
  // A minor's route is the guardian's, and an agent is never substituted for a
  // guardian (§60). The requested mode is ignored rather than partially honoured.
  if (recipient.minor === true) {
    return { ok: true, mode: 'player_only', targets: [recipient], agent: null, agentRefusal: 'MINOR_PATHWAY_DISABLED' };
  }
  if (mode === 'player_only' || !agentOk) {
    return {
      ok: true,
      // Asking for the agent and not being allowed one falls back to the player,
      // who is always a valid route — it does not fail the contact. The caller
      // is TOLD which rule refused, because a club that asked deserves an answer.
      mode: 'player_only',
      targets: [recipient],
      agent: null,
      agentRefusal: agentOk ? null : (agentDecision?.code ?? 'NO_REPRESENTATION'),
    };
  }
  // Defence in depth: a routed agent with no id is not a routed agent. If a
  // basis ever reaches here without naming the individual, refuse rather than
  // record a party that is nobody — a snapshot saying "an agent was routed" with
  // no agent in it is worse than no snapshot at all.
  const agentUserId = agentDecision.basis?.agentUserId ?? null;
  if (typeof agentUserId !== 'string' || !agentUserId) {
    return { ok: true, mode: 'player_only', targets: [recipient], agent: null, agentRefusal: 'NO_REPRESENTATION' };
  }
  const agentTarget = { type: 'agent', agentUserId, agreementId: agentDecision.basis.agreementId, minor: false };
  return { ok: true, mode: 'both', targets: [recipient, agentTarget], agent: agentTarget, agentRefusal: null };
}

/**
 * The snapshot a recorded contact keeps (§22): who was validly routed at that
 * moment, as roles and ids. History is not rewritten when the relationship
 * changes later, and a future contact re-resolves from scratch.
 */
export function contactTargetSnapshot(routing, at = Date.now()) {
  if (!routing?.ok) return null;
  return Object.freeze({
    at,
    mode: routing.mode,
    player: routing.targets.some((t) => t.type === 'player' || t.type === 'guardian'),
    guardian: routing.targets.some((t) => t.type === 'guardian'),
    agent: routing.agent ? { agentUserId: routing.agent.agentUserId, agreementId: routing.agent.agreementId } : null,
    honest: 'Who was validly routed when this contact was recorded. A later change to the relationship does not rewrite it, and the next contact is routed from the authority in force then.',
  });
}

/**
 * The Club-facing agent presence projection (§14/§63). Deliberately thin, and
 * built from named FACTS rather than a single green tick (§65/§66).
 *
 * Nothing about the agreement's terms, no commission, no other client, no
 * compliance evidence and no reviewer note has a field to arrive in.
 */
export function clubAgentPresence({ decision = null, agent = null, agency = null, facets = null } = {}) {
  if (decision?.allowed !== true) return null;
  return Object.freeze({
    represented: true,
    agent: { displayName: agent?.displayName ?? null },
    agency: { id: agency?.id ?? null, name: agency?.name ?? null },
    // Facet by facet, each with the state ScoutBox actually knows. "verified"
    // here means verified IN SCOUTBOX, and the wording says so.
    verification: Object.freeze({
      fifaLicence: facets?.fifa_licence ?? 'unknown',
      nationalRegistration: facets?.national_registration ?? 'unknown',
      domesticAuthorisation: facets?.domestic_authorisation ?? 'unknown',
    }),
    contactPathway: 'contact_agent',
    honest: 'Licence status as verified in ScoutBox, with the date of that check. ScoutBox is not a licence register and does not speak for any governing body. No agreement terms and no fee are shown here, to anyone.',
  });
}

// ---------------------------------------------- §32–§39 transaction handoff

/**
 * The handoff's own states. A handoff is an INVITATION, not a transaction: it
 * records that an authorised club has explicitly decided to take a recruitment
 * case outside its own walls, and it is the thing an agent may then act on.
 *
 * It exists because of §33: a positive internal decision must NOT become a
 * transaction by itself. Nor may the club create the transaction — P5.6D's
 * frozen creation policy is that a licensed individual with current verification
 * opens one (`transactions.write`), and a club unilaterally opening a workspace
 * that names a player and their agent is exactly the internal-intent-becomes-
 * external-commitment move §33 forbids. So the club invites, and the agent (or,
 * for an unrepresented player, nobody yet) opens the canonical transaction.
 */
export const HANDOFF_STATUSES = Object.freeze(['invited', 'accepted', 'withdrawn', 'expired']);

/** How long an uninvited-upon handoff stands before it reads as expired. */
export const HANDOFF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The status a handoff HAS at `now` — an invitation nobody took up goes stale. */
export function effectiveHandoffStatus(h, now = Date.now()) {
  if (!h || !HANDOFF_STATUSES.includes(h.status)) return null;
  if (h.status === 'invited' && typeof h.invitedAt === 'number' && now - h.invitedAt >= HANDOFF_TTL_MS) return 'expired';
  return h.status;
}

/** Every reason a handoff can be refused. One meaning each; none names a person. */
export const HANDOFF_BLOCKERS = Object.freeze([
  'HANDOFF_NOT_PERMITTED',          // the actor's club role does not include this
  'HANDOFF_DECISION_REQUIRED',      // no finalised formal decision to progress exists
  'HANDOFF_CASE_STATE',             // the case is not at a lifecycle point that permits it
  'HANDOFF_SUBJECT_UNAVAILABLE',    // the player is removed, or not visible to this club
  'HANDOFF_MINOR_PATHWAY_DISABLED', // the player is under the age of majority
  'HANDOFF_BLOCKED',                // a canonical block between the player and the club
  'HANDOFF_EXISTS',                 // one is already standing
  'HANDOFF_TRANSACTION_EXISTS',     // a live transaction already covers this context
  'HANDOFF_COMPLIANCE_UNAVAILABLE', // the compliance layer cannot answer right now
]);

/**
 * §34. THE precondition check, pure. Returns every blocker, in `HANDOFF_BLOCKERS`
 * order, so a club sees the whole picture rather than one at a time — and so the
 * readiness view and the mutation cannot disagree, because they call this.
 *
 * What it deliberately does NOT take: the decision's reasons, its note, its
 * evidence or its author. "Do not expose internal rationale" (§34) is enforced
 * by the signature: the rationale is not an argument, so it cannot leak into a
 * refusal, a projection or an event.
 */
export function handoffBlockers({
  canWrite = false,
  hasFinalProgressDecision = false,
  caseStatus = null,
  eligibleCaseStatuses = ['offer_consideration'],
  subjectPresent = false,
  isAdult = false,
  minorPathwayOpen = false,
  blocked = false,
  existingHandoffStatus = null,
  liveTransactionId = null,
  complianceEvaluable = false,
} = {}) {
  const out = [];
  if (canWrite !== true) out.push('HANDOFF_NOT_PERMITTED');
  if (hasFinalProgressDecision !== true) out.push('HANDOFF_DECISION_REQUIRED');
  if (!eligibleCaseStatuses.includes(caseStatus)) out.push('HANDOFF_CASE_STATE');
  if (subjectPresent !== true) out.push('HANDOFF_SUBJECT_UNAVAILABLE');
  if (isAdult !== true && !minorPathwayOpen) out.push('HANDOFF_MINOR_PATHWAY_DISABLED');
  if (blocked === true) out.push('HANDOFF_BLOCKED');
  if (existingHandoffStatus === 'invited' || existingHandoffStatus === 'accepted') out.push('HANDOFF_EXISTS');
  if (typeof liveTransactionId === 'string' && liveTransactionId) out.push('HANDOFF_TRANSACTION_EXISTS');
  if (complianceEvaluable !== true) out.push('HANDOFF_COMPLIANCE_UNAVAILABLE');
  return out;
}

/**
 * §37. The duplicate rule, deterministic and deliberately narrow.
 *
 * Two transactions are "the same context" only when the individual, the type,
 * the engaging entity AND the releasing entity all match and the earlier one is
 * not in a terminal state. Anything else is a legitimately separate transaction:
 * a loan and a permanent transfer for the same player are two different things,
 * two clubs competing for the same player are two different things, and a
 * cancelled one does not block its replacement ("Do not over-block legitimate
 * separate transactions").
 *
 * `partiesOf` is passed in so this stays pure and the caller keeps ownership of
 * the party shape.
 */
export function duplicateTransactionOf(transactions, { clientId, type, engagingOrgId = null, releasingOrgId = null, terminalStatuses = [], partiesOf }) {
  const want = (t) => {
    const parties = partiesOf(t) ?? [];
    const find = (role) => parties.find((p) => p && p.partyRole === role && !p.removed) ?? null;
    return {
      individual: find('individual')?.subjectId ?? null,
      engaging: find('engaging_entity')?.subjectId ?? null,
      releasing: find('releasing_entity')?.subjectId ?? null,
    };
  };
  for (const t of transactions) {
    if (!t || t.type !== type) continue;
    if (terminalStatuses.includes(t.status)) continue;
    const got = want(t);
    if (got.individual !== clientId) continue;
    if ((got.engaging ?? null) !== (engagingOrgId ?? null)) continue;
    if ((got.releasing ?? null) !== (releasingOrgId ?? null)) continue;
    return t;
  }
  return null;
}

/** Does this surface need a compliance answer before it may proceed? */
export const surfaceIsRegulated = (surface) => (Object.hasOwn(SURFACES, surface) ? SURFACES[surface].regulated === true : false);

/** Every scope name a surface can require, for the documents and their tests. */
export const surfaceScopes = (surface) => (Object.hasOwn(SURFACES, surface) ? (SURFACES[surface].scopes ?? null) : null);

export { SCOPES };
