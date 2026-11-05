/**
 * M23 P5.6D — ScoutBox Agent Transaction Workspace: routes.
 *
 * The canonical multi-party workspace connecting Player ↔ Agent ↔ Engaging
 * Club ↔ Releasing Club. Four lanes, mounted on the canonical routers so the
 * existing session, org and player gates run before anything here:
 *
 *   /org/agent/transactions/*   the representing agent's workspace (agency
 *                               session + membership + licensed_agent)
 *   /org/transactions/*         a CLUB party's lane (club session; binding
 *                               acts need the recorded signatory)
 *   /player/transactions/*      the individual party's lane
 *   /ts/transactions/*          attributed Trust & Safety: states and ids,
 *                               no document content, no notes, no messages
 *
 * Every material mutation re-derives, at mutation time, in the frozen §66
 * order: authenticate → actor → transaction → conceal foreign → party role →
 * capability → representation authority → blocks/safeguarding → jurisdiction
 * policy → licence facets → conflict → consent → minor gate → manual review →
 * status transition → rev/idempotency → mutate → audit/event. Nothing in a
 * request body is trusted for any of those facts (§67).
 *
 * S11c: the transactions, their representation bindings and their documents are
 * tables of repositories/agentTransactions.mjs. Every write route is one unit of
 * work (its compliance evaluation, review item, handoff binding, notifications
 * and events included): a refusal after a write that must not stand rolls the
 * whole unit back; a refusal that records a compliance answer commits it.
 *
 * THE FOUR SEPARATIONS, encoded rather than asserted:
 *
 *   transaction ≠ recruitment case  the recruitment case store is not imported,
 *                                   read or written anywhere in this file.
 *   transaction ≠ offer             no offer record, no offer state; only
 *                                   `offerReadiness()` — a boolean and its
 *                                   blockers.
 *   transaction ≠ signing           the signing store is not imported, read or
 *                                   written; no player contract state moves.
 *   compliance ≠ transaction        the verdict comes from the P5.6C engine
 *                                   through one narrow seam; this module owns
 *                                   no rule, no policy and no consent row.
 */

import { guardRev, bumpRev, revMeta } from '../../platform/concurrency.mjs';
import { rateLimitedBody } from '../../platform/rateLimit.mjs';
import { readPage, pageOf, sendPageError } from '../../platform/paging.mjs';
import { normaliseClientKey, payloadFingerprint } from '../../recruitment/lifecycle/contact.mjs';
import { isExpiredAt, isAbsent, parseDateOrInstant } from '../../../temporal.mjs';
import { hasVerLevel } from '../../verification/claims/shared.mjs';
import { effectiveAgreementStatus, agreementGrantsAccess, can } from '../core/shared.mjs';
import { sendTransactionError, notFound } from './errors.mjs';
import { transactionAuditRows } from './audit.mjs';
import { AGENT_TRANSACTION_LIMITS } from '../../../repositories/agentTransactions.mjs';
import {
  partiesOf,
  TRANSACTION_TYPES, TRANSACTION_STATUSES, LIVE_STATUSES, TERMINAL_STATUSES, PARTY_ROLES, ROOM_ROLES,
  ACTOR_TRANSITIONS, ALL_TRANSITIONS, actorTransitionAllowed, complianceTransitionAllowed,
  DOCUMENT_TYPES, DOCUMENT_VISIBILITY, NOTE_VISIBILITY, canSeeVisibility, uploadableVisibilities,
  complianceStateFrom, statusForComplianceState, partyRevisionOf, snapshotStaleness, snapshotView, offerReadiness,
  requiredPartyRoles, partiesConfirmed, partiesAwaitingConfirmation, roomRolesFor, clubPartyRoleOf,
  timelineFor, actorLabel, HOLD_REASON_CODES, CANCEL_REASON_CODES, CLOSE_REASON_CODES,
  TRANSACTION_LIMITS, RELEASING_PARTY_TYPES, PENDING_REASONS,
} from './transaction.mjs';

const HONEST_TRANSACTION = 'A ScoutBox transaction is a permissioned workspace. "Ready" means ScoutBox currently permits this workflow to proceed under the encoded rules — it is not a statement of legal validity, no governing body has approved anything, no offer exists and nothing has been signed.';
/** A refusal after a write that must not stand: the unit rolls back; the answer was already sent. */
const ROLLBACK = Symbol('transaction rollback');
const REASON_CODES_FOR = Object.freeze({ ON_HOLD: HOLD_REASON_CODES, CANCELLED: CANCEL_REASON_CODES, CLOSED: CLOSE_REASON_CODES });
const JURISDICTIONS_MAX = AGENT_TRANSACTION_LIMITS.jurisdictions;
const ID_MAX = AGENT_TRANSACTION_LIMITS.id;

export function registerTransactions(rawCtx) {
  const {
    byId, orgRouter, playerRouter, tsRouter, nextId, notify, broadcast,
    findPlayer, isBlocked, isAdult, orgCanSee, rateLimit, agent, compliance,
    // M23 P5.6E — the cross-app integration seam. A HOLDER filled in after this
    // module registers: it carries the recruitment-case handoff binding. Absent
    // (a suite booting P5.6D alone), a transaction may not cite a recruitment
    // case at all, which is the fail-closed answer.
    integration = null,
    recruitmentReads, // §4.3 step 2: the trials are read through SQL
    scoutingReads, // S9d: the opportunities are read through SQL
    agentTransactions, unit, // S11c: transactions, bindings and documents are explicit repository writes, one unit per route
    channels, // S7d: a linked thread's own authorisation is read from the message threads
  } = rawCtx;
  if (typeof agentTransactions?.transactions?.update !== 'function' || typeof unit !== 'function') throw new TypeError('registerTransactions needs the agent transactions repository and unit from the data layer');
  const { transactions: txs, representations: repsRepo, documents: docsRepo } = agentTransactions;

  const now = () => Date.now();
  const hist = (record, action, by, detail = null) => {
    record.history ??= [];
    record.history.push({ id: nextId('aud'), at: now(), action, by, detail });
  };
  const byAgent = (req) => ({ kind: 'org', userId: req.orgUser.id, name: req.orgUser.name });
  const byClubUser = (req) => ({ kind: 'club_user', userId: req.orgUser.id, name: req.orgUser.name, orgId: req.org.id });
  const byPlayer = (req) => ({ kind: 'player', userId: req.player.id, name: req.player.name });
  const bySystem = (name) => ({ kind: 'system', userId: null, name });
  const limitedOr429 = (res, action, key) => { if (rateLimit.limited(action, key)) { res.status(429).json(rateLimitedBody(action)); return true; } return false; };
  const clientKeyOr400 = (req, res) => {
    const k = normaliseClientKey(req.body?.clientKey);
    if (!k.ok) { sendTransactionError(res, { error: 'TRANSACTION_CLIENT_KEY_INVALID', message: k.message }, 'clientKey'); return undefined; }
    return k.key;
  };
  /**
   * A text field of the request: trimmed and cut to `max` (over-long free text may still be shortened); '' when absent;
   * `undefined` when it is not text at all — junk the route refuses, naming the field, rather than coercing.
   */
  const text = (v, max) => (v === undefined || v === null ? '' : typeof v === 'string' ? v.trim().slice(0, max) : undefined);
  /** An id field: '' when absent; `undefined` (refused, naming the field) when not text or longer than any id. Never cut. */
  const idText = (v) => { const t = v === undefined || v === null ? '' : typeof v === 'string' ? v.trim() : undefined; return t !== undefined && t.length > ID_MAX ? undefined : t; };
  /** Answer `out` and roll the unit back. */
  const refuse = (res, out, where) => { sendTransactionError(res, out, where); throw ROLLBACK; };
  /**
   * Run a route's writes as ONE unit of work. `work` returns the function that answers once the unit committed; a
   * refusal that must leave nothing behind answers and throws ROLLBACK (`refuse`).
   */
  const inUnit = (work) => {
    let reply;
    try { reply = unit(work); } catch (e) { if (e === ROLLBACK) return; throw e; }
    if (typeof reply === 'function') reply();
  };

  /**
   * Record an accepted mutation with a ROLE rather than a person.
   *
   * `rev` is a token every party to the transaction sees, and M18.1's canonical
   * `revBy` carries the display name of whoever moved it — which is right inside
   * one organisation and wrong here: it told the individual which named person
   * at the club had last touched the record, and told a club which named person
   * at the agency had (defect D2). The audit keeps the real actor in
   * `history[].by`; the shared token carries the role, and the 409 conflict body
   * then says "Club signatory changed this" rather than naming someone.
   */
  const bumpTxRev = (record, by) => bumpRev(record, { by: { id: null, name: actorLabel(by)?.label ?? null }, at: now() });

  const txById = (id) => (typeof id === 'string' ? txs.byId(id) : null);
  const repsOf = (txId) => repsRepo.forTransaction(txId);
  const liveRepsOf = (txId) => repsOf(txId).filter((r) => r.status !== 'withdrawn');
  const docsOf = (txId) => docsRepo.forTransaction(txId).filter((d) => !d.removedAt);
  const orgById = (id) => byId.org(id) ?? null;

  // ============================================================ compliance integration

  /** The snapshot as every reader sees it: the stored columns, with the outcome, reasons and versions of its evaluation row. */
  const complianceOf = (tx) => snapshotView(tx, tx.compliance, tx.compliance?.evaluationId ? compliance.evaluationById(tx.compliance.evaluationId) : null);

  /**
   * The party/authority revision: the hash every staleness verdict is measured
   * against. Recomputed from LIVE records on every read and every write, never
   * cached, because a cached revision is exactly the stale fact it exists to
   * detect (§27). `reps` may be handed over by a list that read them in one batch.
   */
  function currentPartyRevision(tx, { reps = null } = {}) {
    const consents = compliance.consentsFor(tx.contextId);
    const blocked = [];
    const minors = [];
    for (const p of partiesOf(tx)) {
      if (p.removed || p.subjectKind !== 'player') continue;
      const pl = findPlayer(p.subjectId);
      if (!pl) { blocked.push(p.subjectId); continue; }
      if (isBlocked(pl.id, tx.agencyOrgId)) blocked.push(pl.id);
      if (!isAdult(pl)) minors.push(pl.id);
    }
    return partyRevisionOf({
      parties: partiesOf(tx), agentUserId: tx.agentUserId, representations: reps ?? repsOf(tx.id),
      consents: consents.map((k) => ({ id: k.id, status: k.status })),
      facetStates: compliance.facetStatesFor(tx.agentUserId) ?? {},
      policyVersions: compliance.lastEvaluation(compliance.contextById(tx.contextId) ?? {})?.policyVersions ?? [],
      blockedSubjectIds: blocked, minorSubjectIds: minors,
    });
  }

  /**
   * The safeguarding gate (§61). A block ends the question before any rule is
   * consulted: it is checked BEFORE relationship scope and before the engine,
   * and its refusal is the uniform concealment answer, so "blocked" is never
   * distinguishable from "does not exist". A regulatory CLEAR never overrides
   * it, which is why it lives here and not inside the conflict engine.
   */
  function safeguardingProblem(tx) {
    for (const p of partiesOf(tx)) {
      if (p.removed || p.subjectKind !== 'player') continue;
      const pl = findPlayer(p.subjectId);
      if (!pl) return 'SUBJECT_GONE';
      if (isBlocked(pl.id, tx.agencyOrgId)) return 'BLOCKED';
      // Minors fail closed: no minor transaction pathway is production-enabled
      // in any jurisdiction (§59, P5.6C MINOR_PATHWAY_PRODUCTION_ENABLED).
      if (!isAdult(pl)) return 'MINOR';
      const org = orgById(tx.agencyOrgId);
      if (!org || !orgCanSee(org, pl)) return 'NOT_VISIBLE';
    }
    return null;
  }

  /**
   * Re-evaluate compliance NOW and record the snapshot on the transaction draft
   * `d` (inside the route's unit). Called on every material mutation and never
   * trusted from a previous request: this is what makes "an old evaluation
   * authorises a new mutation" impossible rather than guarded against (§28).
   */
  function recheckCompliance(d, by) {
    const ctx = compliance.contextById(d.contextId);
    const reps = liveRepsOf(d.id);
    const confirmed = partiesConfirmed(d);
    const guard = safeguardingProblem(d);
    if (guard) {
      // Safeguarding is not a compliance verdict and must not be reported as
      // one: the transaction stops, the snapshot is not refreshed, and the
      // caller's refusal is the uniform 404.
      return { safeguarding: guard, state: null, result: null };
    }
    const gate = compliance.facetGateProblem(d.agentUserId, d.jurisdictions);
    if (gate) {
      const state = complianceStateFrom({ gate: gate.gate ?? 'FACET_NOT_VERIFIED', reasons: gate.reasons ?? [], partiesConfirmed: confirmed, representationCount: reps.length });
      applyComplianceSnapshot(d, { state, result: null, ctx, by });
      return { safeguarding: null, state, result: null, gateProblem: gate };
    }
    if (!ctx) return { safeguarding: null, state: complianceStateFrom({ gate: 'REPRESENTATION_MISSING', partiesConfirmed: confirmed }), result: null };
    compliance.project(ctx, { parties: partiesOf(d), representations: reps });
    const result = compliance.evaluate(ctx, by);
    const state = complianceStateFrom({
      outcome: result.outcome, reasons: result.reasons, consentsOutstanding: result.consentsOutstanding,
      representationCount: reps.length, partiesConfirmed: confirmed,
    });
    applyComplianceSnapshot(d, { state, result, ctx, by });
    return { safeguarding: null, state, result };
  }

  /**
   * Attach the snapshot (§26) to the draft and let it move the status through
   * the COMPLIANCE transition map only. An actor can never reach READY,
   * COMPLIANCE_PENDING or COMPLIANCE_BLOCKED by asking. The snapshot names the
   * evaluation it was taken from (or the gate that refused before the engine
   * ran); its outcome, reasons and versions are that evaluation's own.
   */
  function applyComplianceSnapshot(d, { state, result, ctx, by }) {
    const prev = complianceOf(d)?.state ?? null;
    d.compliance = {
      evaluationId: result ? result.evaluationId : null, gate: result ? null : state.pendingReason,
      evaluatedAt: now(), pendingReason: state.pendingReason ?? null,
      verificationFreshness: compliance.facetStatesFor(d.agentUserId)?.fifa_licence ?? null,
      partyRevision: currentPartyRevision(d),
    };
    d.reEvaluationPending = false;
    if (ctx) compliance.clearReEvaluation(ctx);
    const want = statusForComplianceState(state);
    if (want && want !== d.status && complianceTransitionAllowed(d.status, want)) {
      const from = d.status;
      d.status = want;
      hist(d, 'transaction_status_changed', by ?? bySystem('compliance re-evaluation'), { from, to: want, pendingReason: state.pendingReason ?? null, outcome: state.outcome ?? null });
      broadcast('agent_transaction_status_changed', { orgId: d.agencyOrgId, txId: d.id, status: d.status });
    }
    hist(d, 'transaction_compliance_evaluated', by ?? bySystem('compliance re-evaluation'), { outcome: state.outcome ?? null, pendingReason: state.pendingReason ?? null, reasonCodes: state.reasonCodes, policyVersions: result?.policyVersions ?? [] });
    if (JSON.stringify(prev) !== JSON.stringify(state)) {
      broadcast('agent_transaction_compliance_updated', { orgId: d.agencyOrgId, txId: d.id, outcome: state.outcome ?? 'NONE' });
      notify({ kind: 'org_user', id: d.agentUserId }, 'agent_transaction_compliance', state.blocked
        ? 'A transaction is blocked by an encoded ACTIVE rule. It cannot progress; only changed facts or a new policy version produce a different answer.'
        : state.clear ? 'A transaction is compliance-clear under the currently encoded rules. Nothing has been approved, agreed or signed.'
          : `A transaction cannot currently progress: ${String(state.pendingReason ?? 'compliance pending').replace(/_/g, ' ').toLowerCase()}.`, d.id);
    }
    d.updatedAt = now();
  }

  /**
   * The staleness verdict for a READ: reported, never repaired, and never a
   * clearance. A policy version published for the transaction's jurisdiction
   * flags its compliance context (P5.6C); the transaction reads that flag as
   * POLICY_CHANGED, beside its own (S11c: before, the context's flag was not read).
   */
  const stalenessOf = (tx, { view = complianceOf(tx), reps = null } = {}) => {
    const flagged = tx.reEvaluationPending || !!compliance.contextById(tx.contextId)?.reEvaluationPending;
    return snapshotStaleness({ compliance: view, reEvaluationPending: flagged }, currentPartyRevision(tx, { reps }));
  };

  // ============================================================ projections

  const partyName = (party, viewer) => {
    if (party.subjectKind === 'club') return orgById(party.subjectId)?.name ?? null;
    const pl = findPlayer(party.subjectId);
    if (!pl) return null;
    if (viewer.kind === 'player') return party.subjectId === viewer.playerId ? pl.name : null;
    if (viewer.kind === 'ts_reviewer') return null;
    const org = orgById(viewer.orgId);
    return org && orgCanSee(org, pl) ? pl.name : null;
  };

  /**
   * Does this recruitment case belong to this organisation? Asked before a club
   * is shown a case reference, so the engaging club sees only ITS OWN case id —
   * a reference copied from somewhere else stays invisible.
   *
   * Asked of the P5.6E seam, NOT of the recruitment domain's store: this module
   * does not read it, and that boundary is worth more than the one line it would
   * save. No seam registered → false, so the reference simply does not appear.
   */
  const recruitmentCaseBelongsTo = (caseId, orgId) =>
    integration?.caseBelongsTo ? integration.caseBelongsTo(caseId, orgId) === true : false;

  /** The bindings and live documents of many transactions, read in one batch per table (a list's projection). */
  const batchFor = (list) => {
    const ids = list.map((t) => t.id);
    const reps = repsRepo.forTransactions(ids);
    const docs = docsRepo.liveForTransactions(ids);
    return { reps, docs };
  };

  /**
   * One transaction, projected for ONE viewer. Everything a party may see is
   * decided here from the roles the server derived; nothing is filtered in a
   * client. The derived convenience ids (`playerId`, `engagingOrgId`,
   * `releasingOrgId`) that mandate §6 asks for are computed from `parties[]`,
   * which stays the single truth — the frozen P5.6A §4 shape, and the only one
   * that can carry a party's confirmation and its history.
   */
  function projectTransaction(tx, viewer, batch = null) {
    const roles = roomRolesFor(tx, viewer);
    const partyRole = viewer.kind === 'club' ? clubPartyRoleOf(tx, viewer.orgId) : viewer.kind === 'player' ? 'individual' : null;
    const reps = batch ? batch.reps(tx.id) : repsOf(tx.id);
    const liveDocs = batch ? batch.docs(tx.id) : docsOf(tx.id);
    const view = complianceOf(tx);
    const stale = stalenessOf(tx, { view, reps });
    const state = view?.state ?? null;
    const live = partiesOf(tx).filter((p) => !p.removed);
    const isAgent = roles.includes('representing_agent');
    const consents = compliance.consentsFor(tx.contextId);
    return {
      id: tx.id, type: tx.type, status: tx.status, jurisdictions: tx.jurisdictions,
      // Derived from parties[]; present because a client should not have to
      // search an array for the one party it cares about.
      playerId: live.find((p) => p.partyRole === 'individual')?.subjectId ?? null,
      engagingOrgId: live.find((p) => p.partyRole === 'engaging_entity')?.subjectId ?? null,
      releasingOrgId: live.find((p) => p.partyRole === 'releasing_entity')?.subjectId ?? null,
      viewerRoles: roles, viewerPartyRole: partyRole,
      // The agency's identity is shared with every party: a party is entitled
      // to know who represents whom. The AGENT's individual name is shared
      // too — they are a party's representative, not a hidden actor.
      agency: isAgent || roles.length ? { id: tx.agencyOrgId, name: orgById(tx.agencyOrgId)?.name ?? null } : null,
      parties: partiesOf(tx).map((p) => ({
        id: p.id, partyRole: p.partyRole, subjectKind: p.subjectKind, subjectId: p.subjectId,
        name: partyName(p, viewer), removed: !!p.removed, removedAt: p.removedAt ?? null,
        confirmedAt: p.confirmedAt ?? null, confirmedByKind: p.confirmedBy?.kind ?? null,
        addedAt: p.addedAt, subjectRemovedAt: p.subjectRemovedAt ?? null,
      })),
      requiredPartyRoles: requiredPartyRoles(tx.type),
      awaitingConfirmation: partiesAwaitingConfirmation(tx),
      partiesConfirmed: partiesConfirmed(tx),
      /**
       * Representation bindings. Every party sees WHO represents WHICH party
       * and on what basis — the frozen privacy matrix gives a club "the agent's
       * identity and verification state, the agreement's existence and scope,
       * NOT its fee terms". The agreement id is the agent's own reference and
       * is shown only to the agent.
       */
      representations: reps.map((r) => ({
        id: r.id, partyRole: r.partyRole, agentUserId: r.agentUserId, status: r.status,
        declaredOnly: !!r.declaredOnly, basis: r.agreementId ? 'client_confirmed_agreement' : 'declared',
        scope: r.scope ?? [], jurisdictions: r.jurisdictions ?? [],
        verifiedAt: r.verifiedAt ?? null, withdrawnAt: r.withdrawnAt ?? null, createdAt: r.createdAt,
        ...(isAgent ? { agreementId: r.agreementId ?? null, reviewId: r.reviewId ?? null, firstActAt: r.firstActAt ?? null } : {}),
      })),
      /**
       * The compliance projection. Outcome and reason CODES for every party
       * (privacy matrix row 14: "SUMMARY (outcome + codes; never the other
       * side's agents)"); the policy versions and the evaluation reference for
       * the agent, who is the party the rules bind.
       *
       * `clear` is the CURRENT answer, so a stale snapshot is never presented as
       * one: a client that reads only this field would otherwise be told the
       * transaction is clear on the strength of an evaluation that no longer
       * matches the facts. The recorded verdict stays visible as `snapshotClear`
       * beside the staleness reason, because "what the last evaluation said" is
       * a real and useful fact — it is just not a clearance.
       */
      compliance: state ? {
        outcome: state.outcome, pendingReason: stale ? (state.pendingReason ?? 'SNAPSHOT_STALE') : state.pendingReason,
        blocked: state.blocked, clear: state.clear && !stale, snapshotClear: state.clear,
        reasonCodes: state.reasonCodes, consentRequirements: view.consentRequirements,
        evaluatedAt: view.evaluatedAt, stale, staleness: stale,
        ...(isAgent ? { evaluationId: view.evaluationId, contextId: view.contextId, policyVersions: view.policyVersions, verificationFreshness: view.verificationFreshness } : {}),
        honest: 'ScoutBox has evaluated its own encoded rules. It has not determined anyone\'s legal rights and no governing body has approved anything.',
      } : { outcome: null, pendingReason: 'PARTIES_NOT_CONFIRMED', blocked: false, clear: false, reasonCodes: [], consentRequirements: [], evaluatedAt: null, stale: 'NO_SNAPSHOT', staleness: 'NO_SNAPSHOT', honest: 'No compliance evaluation has been recorded for this transaction yet.' },
      /**
       * The consent view (§29): required parties and each answer's state,
       * projected from the P5.6C ledger. A party sees its OWN consent in full
       * and another party's as a state only — never its particulars, never who
       * signed it (§30).
       */
      consents: consents.map((k) => {
        const mine = (viewer.kind === 'player' && k.subject?.kind === 'player' && k.subject.id === viewer.playerId)
          || (viewer.kind === 'club' && k.subject?.kind === 'club' && k.subject.id === viewer.orgId);
        return {
          id: mine || isAgent ? k.id : null, kind: k.kind, partyRole: k.partyRole, status: k.status,
          requestedAt: k.requestedAt ?? null, grantedAt: k.grantedAt ?? null, declinedAt: k.declinedAt ?? null, revokedAt: k.revokedAt ?? null,
          mine: !!mine,
          ...(mine ? { particulars: k.particulars ?? null, policyVersions: k.policyVersions ?? [] } : {}),
        };
      }),
      documents: liveDocs.filter((d) => canSeeVisibility(d.visibility, roles, partyRole) && !d.supersededBy).map((d) => documentView(d, roles, partyRole)),
      // Notes reuse the visibility classes; a note nobody may see is absent,
      // not redacted, so its existence is not disclosed either.
      notes: tx.notes.filter((n) => canSeeVisibility(n.visibility, roles, partyRole)).map((n) => ({ id: n.id, visibility: n.visibility, text: n.text, at: n.at, actor: actorLabel(n.by) })),
      linkedThreads: tx.linkedThreads.map((t) => ({ id: t.id, channelId: t.channelId, linkedAt: t.linkedAt, actor: actorLabel(t.linkedBy), readable: channelReadableBy(t.channelId, viewer) })),
      // M23 P5.6E §36. The recruitment-case reference is visible ONLY to the
      // representing agent and to the club that OWNS that case. A club's internal
      // recruitment case is club-private (P5.6D §46): the individual does not
      // learn its id, Trust & Safety has no use for it, and a releasing club must
      // never learn the engaging club's internal case — which is precisely what
      // an unconditional field here would have told all three. Absent, not
      // redacted, so its existence is not disclosed either.
      links: {
        trialId: tx.links.trialId ?? null,
        opportunityId: tx.links.opportunityId ?? null,
        ...(tx.links.recruitmentCaseId && (isAgent || (viewer.kind === 'club' && partyRole === 'engaging_entity' && recruitmentCaseBelongsTo(tx.links.recruitmentCaseId, viewer.orgId)))
          ? { recruitmentCaseId: tx.links.recruitmentCaseId } : {}),
      },
      terms: isAgent || roles.includes('party_club_signatory') || roles.includes('party_individual')
        ? { versions: tx.terms.versions.filter((v) => canSeeVisibility(v.visibility, roles, partyRole)).map((v) => ({ id: v.id, at: v.at, summary: v.summary, visibility: v.visibility, recordedFor: v.recordedFor, actor: actorLabel(v.by) })) }
        : { versions: [] },
      offerBoundary: offerReadiness(tx, { complianceState: state, staleness: stale }),
      hold: tx.status === 'ON_HOLD' ? { reasonCode: tx.holdReasonCode ?? null, reason: roles.length ? tx.holdReason ?? null : null, at: tx.heldAt ?? null } : null,
      cancelReasonCode: tx.cancelReasonCode ?? null, closeReasonCode: tx.closeReasonCode ?? null,
      allowedTransitions: allowedTransitionsFor(tx, roles),
      initiatedBy: tx.initiatedBy?.kind ?? null, initiatedAt: tx.initiatedAt,
      createdAt: tx.createdAt, updatedAt: tx.updatedAt, ...revMeta(tx),
      honest: HONEST_TRANSACTION,
    };
  }

  /** What a viewer may see of one document. Never the bytes: this module stores none. */
  const documentView = (d, roles, partyRole) => ({
    id: d.id, documentType: d.documentType, visibility: d.visibility, version: d.version,
    label: d.label, ownerKind: d.owner?.kind ?? null, ownerPartyRole: d.ownerPartyRole ?? null,
    uploadedAt: d.createdAt, actor: actorLabel(d.uploadedBy),
    expiresAt: d.expiresAt ?? null, expired: isExpiredAt(d.expiresAt, now()), // M23 P5.7: an unreadable expiry reads expired, never "current"
    // §32: a signature instant is recordable only when objectively known from the underlying evidence; no writer knows
    // one, so none is stored (S11c) and none is claimed.
    signedAt: null, supersedes: d.supersedes ?? null,
    evidence: d.evidenceRef ? { kind: d.evidenceRef.kind, present: true } : null,
    downloadable: !!d.evidenceRef && canSeeVisibility(d.visibility, roles, partyRole),
    ...revMeta(d),
  });

  /**
   * Does this viewer pass the CANONICAL channel authorization for a linked
   * thread? Transaction membership is never the answer (§81): the link says a
   * conversation exists, and reading it still needs the Inbox's own gate.
   */
  function channelReadableBy(channelId, viewer) {
    const ch = channels.byId(channelId);
    if (!ch) return false;
    if (viewer.kind === 'player') return ch.playerId === viewer.playerId && ch.counterparty === 'player';
    if (viewer.kind === 'club') return ch.orgId === viewer.orgId;
    return false;
  }

  /** Which transitions this viewer may currently request. Compliance-driven states never appear. */
  function allowedTransitionsFor(tx, roles) {
    if (!roles.includes('representing_agent')) return [];
    return (ACTOR_TRANSITIONS[tx.status] ?? []).slice();
  }

  // ============================================================ resolution + authorization

  /** Steps 1–6 for the AGENT lane. Conceals every transaction that is not this agent's own. */
  function ownTransaction(req, res, id, { write = false } = {}) {
    if (!agent.resolveMembership(req, res)) return null;
    if (!agent.requireCap(req, res, write ? 'transactions.write' : 'transactions.read')) return null;
    const tx = txById(id);
    // Same-agency privacy: a colleague's transaction is 404, not 403, so the
    // existence of a colleague's client work is not disclosed (P5.6A DR-25).
    if (!tx || tx.agencyOrgId !== req.org.id || tx.agentUserId !== req.orgUser.id) { notFound(res, 'transaction'); return null; }
    return tx;
  }

  /** Steps 1–6 for the CLUB lane. A club that is not a party sees nothing. */
  function clubTransaction(req, res, id, { signatory = false } = {}) {
    if (req.org.type !== 'club') { notFound(res, 'transaction'); return null; }
    const tx = txById(id);
    const role = tx ? clubPartyRoleOf(tx, req.org.id) : null;
    if (!tx || !role) { notFound(res, 'transaction'); return null; }
    if (signatory && !hasVerLevel(rawCtx.verificationReads, req.org.id, req.orgUser.id, 'verification_admin')) {
      sendTransactionError(res, { error: 'SIGNATORY_REQUIRED', message: 'Only a recorded club signatory (a verification administrator) may act for the club here.' }, 'transaction');
      return null;
    }
    req.txPartyRole = role;
    return tx;
  }

  /** Steps 1–6 for the PLAYER lane. */
  function playerTransaction(req, res, id) {
    if (req.playerIsMinor) { notFound(res, 'transaction'); return null; }
    const tx = txById(id);
    if (!tx || !partiesOf(tx).some((p) => !p.removed && p.subjectKind === 'player' && p.subjectId === req.player.id)) { notFound(res, 'transaction'); return null; }
    return tx;
  }

  const clubViewer = (req) => ({ kind: 'club', orgId: req.org.id, userId: req.orgUser.id, signatory: hasVerLevel(rawCtx.verificationReads, req.org.id, req.orgUser.id, 'verification_admin') });
  const agentViewer = (req) => ({ kind: 'agency', orgId: req.org.id, userId: req.orgUser.id, agencyAdmin: can(req.tiers, 'agency.compliance.read') });
  const playerViewer = (req) => ({ kind: 'player', playerId: req.player.id });

  /** Steps 8 and 15 for any write: safeguarding, then liveness. */
  function writableOr(res, tx, where) {
    const guard = safeguardingProblem(tx);
    // The READ stays available: the transaction is the parties' own record of
    // what happened, and the P5.6C precedent keeps such a record readable with
    // the person tombstoned out of it. The WRITE stops, and says so in terms
    // that are identical for removed, invisible, blocked and minor — so the
    // refusal is honest to a caller who can already see the record, and is
    // still not an oracle.
    if (guard) { sendTransactionError(res, { error: 'TRANSACTION_PARTY_UNAVAILABLE', message: 'A party to this transaction is no longer available to your organisation. Nothing further can be written to it; its record stays.' }, where); return false; }
    if (tx.status === 'ARCHIVED') { sendTransactionError(res, { error: 'TRANSACTION_ARCHIVED', status: tx.status, message: 'An archived transaction is read-only.' }, where); return false; }
    if (!LIVE_STATUSES.includes(tx.status)) { sendTransactionError(res, { error: 'TRANSACTION_NOT_LIVE', status: tx.status, message: 'This transaction has ended. Its record stays; nothing further can be written to it.' }, where); return false; }
    return true;
  }
  /** The rev guard inside a unit: a stale rev answers 409 and rolls back whatever the unit already wrote. */
  const guardRevOrRollback = (req, res, record, opts) => { if (!guardRev(req, res, record, opts)) throw ROLLBACK; };
  const TX_CONFLICT = (tx) => ({ errorCode: 'TRANSACTION_VERSION_CONFLICT', current: { status: tx.status } });

  // ============================================================ party resolution

  /**
   * Resolve one named party against LIVE records (§8: canonical ids, never
   * names). Uniform concealment: a player who does not exist, a minor, a
   * player the agency cannot see and a player who blocked the agency all
   * answer the same 404, so the route is not an age or a block oracle
   * (adversarial 23).
   */
  function resolveParty(req, res, raw, { type }) {
    const shapeOk = raw !== null && typeof raw === 'object' && !Array.isArray(raw) && [raw.partyRole, raw.subjectKind, raw.subjectId].every((v) => typeof v === 'string');
    if (!shapeOk || !PARTY_ROLES.includes(raw.partyRole) || !['player', 'club'].includes(raw.subjectKind) || !raw.subjectId || raw.subjectId.length > ID_MAX) {
      sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'parties', allowed: PARTY_ROLES, message: 'Each party needs partyRole (individual | engaging_entity | releasing_entity), subjectKind (player | club) and subjectId, as text.' }, 'party');
      return null;
    }
    const { partyRole, subjectKind, subjectId } = raw;
    if (partyRole === 'releasing_entity' && !RELEASING_PARTY_TYPES.includes(type)) {
      sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'partyRole', message: 'A releasing entity exists only in a transfer or a loan.' }, 'party');
      return null;
    }
    const party = (id) => ({ id: nextId('txp'), partyRole, subjectKind, subjectId: id, addedAt: now(), addedBy: byAgent(req), removed: false, removedAt: null, confirmedAt: null, confirmedBy: null, subjectRemovedAt: null });
    if (subjectKind === 'player') {
      if (partyRole !== 'individual') { sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'partyRole', message: 'A player is the individual party.' }, 'party'); return null; }
      const pl = findPlayer(subjectId);
      if (!pl || !isAdult(pl) || !orgCanSee(req.org, pl) || isBlocked(pl.id, req.org.id)) { sendTransactionError(res, { error: 'TRANSACTION_PARTY_NOT_FOUND', message: 'No such party is available to you.' }, 'party'); return null; }
      return party(pl.id);
    }
    if (partyRole === 'individual') { sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'partyRole', message: 'A club is an engaging or a releasing entity.' }, 'party'); return null; }
    const org = orgById(subjectId);
    if (!org || org.type !== 'club') { sendTransactionError(res, { error: 'TRANSACTION_PARTY_NOT_FOUND', message: 'No such party is available to you.' }, 'party'); return null; }
    return party(org.id);
  }

  /** Notify a party that the workspace needs something from it. Ids and states only. */
  function notifyParty(tx, party, type, message) {
    if (party.subjectKind === 'player') notify({ kind: 'player', id: party.subjectId }, type, message, tx.id);
    else for (const u of rawCtx.verificationReads.admins.activeForOrg(party.subjectId)) notify({ kind: 'org_user', id: u.userId }, type, message, tx.id);
  }

  /**
   * The duplicate rule (§37), asked of the indexed candidates: the live transactions of this type naming this individual.
   * The rule itself is P5.6E's one definition (`duplicateTransactionOf`); absent (a suite booting P5.6D alone), none.
   */
  const duplicateOf = ({ individualId, type, engagingOrgId, releasingOrgId }) => (integration?.duplicateTransactionOf
    ? integration.duplicateTransactionOf(txs.liveForIndividual(individualId, type), { clientId: individualId, type, engagingOrgId, releasingOrgId, terminalStatuses: TERMINAL_STATUSES, partiesOf: (t) => t.parties })
    : null);

  /** A list page of `rows` ({ key, record }) and its cursor. */
  const pageItems = (rows, limit) => { const p = pageOf(rows, limit, (r) => r.key); return { records: p.items.map((r) => r.record), nextCursor: p.nextCursor }; };
  const statusFilterOr400 = (req, res) => {
    if (req.query.status === undefined || req.query.status === '') return null;
    if (typeof req.query.status !== 'string' || !TRANSACTION_STATUSES.includes(req.query.status)) { sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'status', allowed: TRANSACTION_STATUSES }, 'list'); return undefined; }
    return req.query.status;
  };

  // ============================================================ AGENT lane

  orgRouter.get('/agent/transactions', (req, res) => {
    if (!agent.resolveMembership(req, res)) return;
    if (!agent.requireCap(req, res, 'transactions.read')) return;
    const status = statusFilterOr400(req, res); if (status === undefined) return;
    let pageReq; try { pageReq = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
    // Personal to the agent: a colleague's transactions are not listed and
    // their count is not disclosed either. Newest first, by cursor; the counts
    // are over every transaction of the agent's, not this page.
    const { records, nextCursor } = pageItems(txs.agentPage({ agencyOrgId: req.org.id, agentUserId: req.orgUser.id, status, ...pageReq }).rows, pageReq.limit);
    const viewer = agentViewer(req);
    const batch = batchFor(records);
    res.json({
      items: records.map((t) => projectTransaction(t, viewer, batch)), nextCursor,
      statuses: TRANSACTION_STATUSES, types: TRANSACTION_TYPES, partyRoles: PARTY_ROLES,
      documentTypes: DOCUMENT_TYPES, visibilities: DOCUMENT_VISIBILITY, roomRoles: ROOM_ROLES,
      holdReasonCodes: HOLD_REASON_CODES, cancelReasonCodes: CANCEL_REASON_CODES, closeReasonCodes: CLOSE_REASON_CODES,
      transitions: ALL_TRANSITIONS, pendingReasons: PENDING_REASONS,
      counts: txs.agentCounts(req.org.id, req.orgUser.id),
      honest: HONEST_TRANSACTION,
    });
  });

  /**
   * Create a transaction. Opened by the licensed agent — the frozen owner in
   * M23_P56A_AGENT_STORE_PROPOSAL.md §4 ("Opened by the agent; each party owns
   * its lane"). A club's own lane is its party routes; a club cannot open a
   * transaction and neither can agency support staff (§62).
   *
   * Creation grants NO authority (§63): the parties are named, not confirmed;
   * no representation exists; no consent exists; the status is DRAFT and the
   * compliance projection says PARTIES_NOT_CONFIRMED.
   */
  orgRouter.post('/agent/transactions', (req, res) => {
    if (!agent.resolveMembership(req, res)) return;
    if (!agent.requireCap(req, res, 'transactions.write')) return;
    const b = req.body ?? {};
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    if (typeof b.type !== 'string' || !TRANSACTION_TYPES.includes(b.type)) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'type', allowed: TRANSACTION_TYPES }, 'create');
    const type = b.type;
    const jurisdictions = Array.isArray(b.jurisdictions) && b.jurisdictions.every((j) => typeof j === 'string') ? [...new Set(b.jurisdictions.map((j) => j.toUpperCase()))] : [];
    if (!jurisdictions.length || jurisdictions.length > JURISDICTIONS_MAX || jurisdictions.some((j) => !/^[A-Z]{3}$/.test(j))) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'jurisdictions', message: `jurisdictions must be a non-empty list of up to ${JURISDICTIONS_MAX} three-letter member-association codes (INT for FIFA level).` }, 'create');
    if (b.parties !== undefined && b.parties !== null && (!Array.isArray(b.parties) || b.parties.length > TRANSACTION_LIMITS.parties)) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'parties', message: `parties must be a list of up to ${TRANSACTION_LIMITS.parties} parties.` }, 'create');
    if (b.recruitmentCaseId !== undefined && b.recruitmentCaseId !== null && b.recruitmentCaseId !== '' && (typeof b.recruitmentCaseId !== 'string' || b.recruitmentCaseId.length > ID_MAX)) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'recruitmentCaseId', message: 'recruitmentCaseId must be the id of a recruitment case, as text.' }, 'create');
    const rawParties = Array.isArray(b.parties) ? b.parties : [];
    const fp = payloadFingerprint({ type, jurisdictions, parties: rawParties });
    if (key) {
      const hit = txs.byCreateKey(req.org.id, req.orgUser.id, key);
      if (hit) {
        if (hit.keys.create.fp === fp) return res.json({ transaction: projectTransaction(hit, agentViewer(req)), idempotent: true });
        return sendTransactionError(res, { error: 'TRANSACTION_IDEMPOTENCY_CONFLICT', message: 'That idempotency key was used for a different request.' }, 'create');
      }
    }
    if (limitedOr429(res, 'transaction_write', req.orgUser.id)) return;
    // Step 10: the agent's own facets under the applicable policy set. A
    // transaction is regulated infrastructure; an unverified licence does not
    // open one.
    const gate = compliance.facetGateProblem(req.orgUser.id, jurisdictions);
    if (gate) return sendTransactionError(res, { ...gate, message: gate.error === 'JURISDICTION_UNSUPPORTED' ? 'No encoded policy covers this jurisdiction. A transaction cannot be opened for it.' : `A regulated action needs a VERIFIED ${gate.facet}${gate.memberAssociation ? ` (${gate.memberAssociation})` : ''}; it is ${gate.state}.` }, 'create');
    const parties = [];
    for (const raw of rawParties) {
      const party = resolveParty(req, res, raw, { type }); if (!party) return;
      if (parties.some((x) => x.partyRole === party.partyRole)) return sendTransactionError(res, { error: 'TRANSACTION_PARTY_EXISTS', partyRole: party.partyRole, message: `A ${party.partyRole} party is already named.` }, 'create');
      parties.push(party);
    }

    // M23 P5.6E §36/§37. An optional reference back to the recruitment case whose
    // club invited this workspace, and the duplicate rule. Both are REFERENCES:
    // nothing about the case is copied in, and the case's own truth stays its own.
    const caseRef = typeof b.recruitmentCaseId === 'string' && b.recruitmentCaseId ? b.recruitmentCaseId : null;
    const individualId = parties.find((p) => p.partyRole === 'individual')?.subjectId ?? null;
    if (individualId) {
      const dup = duplicateOf({
        individualId, type,
        engagingOrgId: parties.find((p) => p.partyRole === 'engaging_entity')?.subjectId ?? null,
        releasingOrgId: parties.find((p) => p.partyRole === 'releasing_entity')?.subjectId ?? null,
      });
      // Same individual, same type, same clubs on both sides, and the earlier one
      // still live. A loan beside a transfer, or a second engaging club, is a
      // legitimately separate transaction and is NOT refused.
      if (dup) return sendTransactionError(res, { error: 'TRANSACTION_DUPLICATE_CONTEXT', transactionId: dup.id, message: 'A live transaction already covers this individual, this type and these clubs. Continue in that one, or end it first.' }, 'create');
    }
    if (caseRef && !integration?.bindHandoff) return sendTransactionError(res, { error: 'HANDOFF_NOT_FOUND', message: 'A recruitment case cannot be referenced in this build.' }, 'create');
    const at = now();
    const id = nextId('atx');
    inUnit(() => {
      // §32/§36. A workspace that cites a recruitment case must be answering that
      // club's own invitation, and the invitation must have been addressed to this
      // agency. Bound in the same unit as the transaction, so a refusal leaves
      // nothing behind: a citation that does not check out creates no transaction
      // at all, rather than a transaction with a reference nobody authorised.
      if (caseRef) {
        const problem = integration.bindHandoff({
          recruitmentCaseId: caseRef, transactionId: id, agencyOrgId: req.org.id,
          agentUserId: req.orgUser.id, clientId: individualId, at,
        });
        if (problem) {
          refuse(res, {
            error: problem,
            message: 'No open invitation from that recruitment case is addressed to you. A club invites a workspace; citing a case you were not invited to does not open one.',
          }, 'create');
        }
      }
      const ctx = compliance.openContext({ agencyOrgId: req.org.id, agentUserId: req.orgUser.id, type, jurisdictions, transactionId: id, by: byAgent(req) });
      const tx = {
        id, agencyOrgId: req.org.id, agentUserId: req.orgUser.id, type, jurisdictions,
        status: 'DRAFT', parties, contextId: ctx.id, compliance: null, reEvaluationPending: false,
        notes: [], linkedThreads: [], links: { trialId: null, opportunityId: null, recruitmentCaseId: caseRef }, terms: { versions: [] },
        holdReasonCode: null, holdReason: null, heldAt: null, cancelReasonCode: null, cancelledAt: null, closeReasonCode: null, closedAt: null, archivedAt: null,
        initiatedBy: byAgent(req), createdAt: at, updatedAt: at,
        keys: key ? { create: { key, fp } } : {}, rev: 1, revAt: at, revBy: null, history: [],
      };
      hist(tx, 'transaction_created', byAgent(req), { count: parties.length });
      txs.create(tx);
      txs.update(id, (d) => { recheckCompliance(d, byAgent(req)); });
      broadcast('agent_transaction_created', { orgId: req.org.id, txId: id });
      for (const p of parties) notifyParty(tx, p, 'agent_transaction_action', `A transaction workspace has been opened naming you as the ${p.partyRole.replace(/_/g, ' ')}. Confirm your participation to let it proceed. Confirming does not agree to any terms.`);
      const stored = txById(id);
      return () => res.status(201).json({ transaction: projectTransaction(stored, agentViewer(req)) });
    });
  });

  orgRouter.get('/agent/transactions/:id', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id); if (!tx) return;
    res.json({ transaction: projectTransaction(tx, agentViewer(req)) });
  });

  orgRouter.post('/agent/transactions/:id/parties', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    if (!writableOr(res, tx, 'parties')) return;
    if (limitedOr429(res, 'transaction_write', req.orgUser.id)) return;
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    const party = resolveParty(req, res, req.body, { type: tx.type }); if (!party) return;
    const fp = payloadFingerprint({ partyRole: party.partyRole, subjectId: party.subjectId });
    if (key && tx.keys[`party:${key}`]) { if (tx.keys[`party:${key}`].fp === fp) return res.json({ transaction: projectTransaction(tx, agentViewer(req)), idempotent: true }); return sendTransactionError(res, { error: 'TRANSACTION_IDEMPOTENCY_CONFLICT' }, 'parties'); }
    if (partiesOf(tx).some((x) => !x.removed && x.partyRole === party.partyRole)) return sendTransactionError(res, { error: 'TRANSACTION_PARTY_EXISTS', partyRole: party.partyRole }, 'parties');
    if (partiesOf(tx).length >= TRANSACTION_LIMITS.parties * 3) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'parties', message: 'This transaction already holds the maximum number of party records.' }, 'parties');
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      txs.update(tx.id, (d) => {
        d.parties.push(party);
        if (key) d.keys[`party:${key}`] = { key, fp };
        hist(d, 'transaction_party_added', byAgent(req), { partyRole: party.partyRole, subjectKind: party.subjectKind });
        // A party change invalidates every prior clearance (§10): the compliance
        // snapshot is recomputed here and now, not carried over.
        partyChanged(d, byAgent(req));
        bumpTxRev(d, byAgent(req));
      });
      broadcast('agent_transaction_party_changed', { orgId: tx.agencyOrgId, txId: tx.id, partyRole: party.partyRole });
      notifyParty(tx, party, 'agent_transaction_action', `A transaction workspace now names you as the ${party.partyRole.replace(/_/g, ' ')}. Confirm your participation to let it proceed. Confirming does not agree to any terms.`);
      const stored = txById(tx.id);
      return () => res.status(201).json({ transaction: projectTransaction(stored, agentViewer(req)) });
    });
  });

  /**
   * Remove a party. History is never overwritten (§9): the row stays with its
   * `removedAt`, every representation naming that role is withdrawn, and the
   * transaction drops back out of any compliance claim it had.
   */
  orgRouter.post('/agent/transactions/:id/parties/:pid/remove', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    if (!writableOr(res, tx, 'parties')) return;
    const party = partiesOf(tx).find((p) => p && p.id === req.params.pid);
    if (!party) return sendTransactionError(res, { error: 'TRANSACTION_PARTY_NOT_FOUND' }, 'parties');
    if (party.removed) return res.json({ transaction: projectTransaction(tx, agentViewer(req)), idempotent: true });
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      for (const r of repsOf(tx.id)) {
        if (r.partyRole !== party.partyRole || r.status === 'withdrawn') continue;
        repsRepo.update(r.id, (x) => {
          x.status = 'withdrawn'; x.withdrawnAt = now(); x.withdrawnReason = 'party_removed';
          hist(x, 'transaction_representation_withdrawn', byAgent(req), { partyRole: x.partyRole, status: 'withdrawn' });
          bumpRev(x, { by: req.orgUser, at: now() });
        });
      }
      txs.update(tx.id, (d) => {
        const p = d.parties.find((x) => x.id === party.id);
        p.removed = true; p.removedAt = now();
        hist(d, 'transaction_party_removed', byAgent(req), { partyRole: party.partyRole, subjectKind: party.subjectKind });
        partyChanged(d, byAgent(req));
        bumpTxRev(d, byAgent(req));
      });
      broadcast('agent_transaction_party_changed', { orgId: tx.agencyOrgId, txId: tx.id, partyRole: party.partyRole });
      const stored = txById(tx.id);
      return () => res.json({ transaction: projectTransaction(stored, agentViewer(req)) });
    });
  });

  /**
   * What a party change does, in one place so it cannot be done differently in
   * two routes: a confirmed transaction that loses its confirmation set falls
   * back out of READY/ACTIVE, and compliance is re-evaluated immediately.
   */
  function partyChanged(d, by) {
    if (!partiesConfirmed(d) && ['READY', 'ACTIVE', 'COMPLIANCE_PENDING', 'COMPLIANCE_BLOCKED'].includes(d.status)) {
      const from = d.status;
      d.status = 'PARTIES_CONFIRMED';
      hist(d, 'transaction_status_changed', by, { from, to: d.status, pendingReason: 'PARTIES_NOT_CONFIRMED' });
      broadcast('agent_transaction_status_changed', { orgId: d.agencyOrgId, txId: d.id, status: d.status });
    }
    if (d.status === 'DRAFT' && partiesConfirmed(d)) {
      hist(d, 'transaction_status_changed', by, { from: 'DRAFT', to: 'PARTIES_CONFIRMED' });
      d.status = 'PARTIES_CONFIRMED';
      broadcast('agent_transaction_status_changed', { orgId: d.agencyOrgId, txId: d.id, status: d.status });
    }
    recheckCompliance(d, by);
  }

  /**
   * THE regulated mutation of P5.6D: bind a representation to this transaction.
   *
   * "Active for this player" is not authority for this transaction (§24): the
   * agreement is re-read now, its scope must cover this transaction's type and
   * every one of its jurisdictions, the facets must be verified now, and the
   * conflict engine must answer now with this binding included. A refusal at
   * any step records no binding.
   */
  orgRouter.post('/agent/transactions/:id/representations', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    if (!writableOr(res, tx, 'representations')) return;
    const b = req.body ?? {};
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    if (typeof b.partyRole !== 'string') return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'partyRole', allowed: PARTY_ROLES }, 'representations');
    if (b.agreementId !== undefined && b.agreementId !== null && (typeof b.agreementId !== 'string' || b.agreementId.length > ID_MAX)) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'agreementId', message: 'agreementId must be the id of your agreement with this party, as text.' }, 'representations');
    const partyRole = b.partyRole;
    const party = partiesOf(tx).find((p) => !p.removed && p.partyRole === partyRole);
    if (!party) return sendTransactionError(res, { error: 'TRANSACTION_PARTY_NOT_FOUND' }, 'representations');
    const fp = payloadFingerprint({ partyRole, agreementId: b.agreementId ?? null });
    if (key) {
      const hit = repsRepo.byAttachKey(tx.id, key);
      if (hit) { if (hit.keys.attach.fp === fp) return res.json({ transaction: projectTransaction(tx, agentViewer(req)), idempotent: true }); return sendTransactionError(res, { error: 'TRANSACTION_IDEMPOTENCY_CONFLICT' }, 'representations'); }
    }
    if (limitedOr429(res, 'transaction_write', req.orgUser.id)) return;
    if (liveRepsOf(tx.id).some((r) => r.partyRole === partyRole && r.agentUserId === req.orgUser.id)) {
      return sendTransactionError(res, { error: 'TRANSACTION_PARTY_EXISTS', partyRole, message: 'You already represent this party in this transaction.' }, 'representations');
    }
    // Step 8: safeguarding before scope, so a blocked party is never
    // distinguishable from an unknown one by comparing refusals.
    let agreement = null; let declaredOnly = false; let scope = []; let jurisdictions = [];
    if (party.subjectKind === 'player') {
      const pl = findPlayer(party.subjectId);
      if (!pl || !isAdult(pl) || !orgCanSee(req.org, pl) || isBlocked(pl.id, req.org.id)) return sendTransactionError(res, { error: 'TRANSACTION_PARTY_NOT_FOUND' }, 'representations');
      const named = typeof b.agreementId === 'string' ? rawCtx.agentReads.agreements.byId(b.agreementId) : null;
      agreement = named && named.agentUserId === req.orgUser.id && named.agencyOrgId === req.org.id && named.clientId === party.subjectId ? named : null;
      if (!agreement) return sendTransactionError(res, { error: 'REPRESENTATION_REQUIRED', message: 'A client-confirmed, active relationship with this party is required (agreementId).' }, 'representations');
      const st = effectiveAgreementStatus(agreement, now());
      const problem = compliance.representationScopeProblem({
        agreement, effectiveStatus: st,
        confirmed: agreement.confirmedAt != null && agreementGrantsAccess(agreement, req.orgUser.id, now()),
        contextType: tx.type, memberAssociations: tx.jurisdictions,
      });
      if (problem) return sendTransactionError(res, { ...problem, message: problem.error === 'REPRESENTATION_SCOPE_INSUFFICIENT' ? 'The relationship does not cover this transaction\'s scope or jurisdiction.' : 'No active, client-confirmed relationship covers this party.' }, 'representations');
      scope = agreement.scope ?? []; jurisdictions = agreement.jurisdiction ? [agreement.jurisdiction] : [];
    } else {
      // An entity client with no ScoutBox agreement is DECLARED ONLY and needs
      // attributed review; it is never a verified binding (P5.6A DR-18).
      declaredOnly = true;
    }
    // Step 10: facets now.
    const gate = compliance.facetGateProblem(req.orgUser.id, tx.jurisdictions);
    if (gate) return sendTransactionError(res, { ...gate, message: gate.error === 'JURISDICTION_UNSUPPORTED' ? 'No encoded policy covers this jurisdiction.' : `A regulated action needs a VERIFIED ${gate.facet}${gate.memberAssociation ? ` (${gate.memberAssociation})` : ''}; it is ${gate.state}.` }, 'representations');
    inUnit(() => {
      // Steps 11–14: conflict, consent, minor gate and review, with the proposed
      // binding included. No binding is recorded if the answer is not permissive;
      // the evaluation itself is, and the transaction's snapshot names it.
      const ctx = compliance.contextById(tx.contextId);
      const live = liveRepsOf(tx.id);
      compliance.project(ctx, { parties: partiesOf(tx), representations: live });
      const proposed = { agentUserId: req.orgUser.id, partyRole, agreementId: agreement?.id ?? null, declaredOnly, status: declaredOnly ? 'declared' : 'verified', firstActAt: now() };
      const result = compliance.evaluate(ctx, byAgent(req), { proposed });
      const snapshotAndRefuse = (state, out) => {
        txs.update(tx.id, (d) => { applyComplianceSnapshot(d, { state, result, ctx, by: byAgent(req) }); bumpTxRev(d, byAgent(req)); });
        return () => sendTransactionError(res, out, 'representations');
      };
      if (result.outcome === 'PROHIBITED_CONFLICT') {
        return snapshotAndRefuse(complianceStateFrom({ outcome: result.outcome, reasons: result.reasons, representationCount: live.length, partiesConfirmed: partiesConfirmed(tx) }),
          { error: 'REPRESENTATION_CONFLICT', reasons: result.reasons.filter((r) => ['PROHIBITED_COMBINATION', 'COMBINATION_NOT_PERMITTED', 'CONNECTED_AGENT_ATTRIBUTION'].includes(r.code)), policyVersions: result.policyVersions, outcome: result.outcome, message: 'An encoded ACTIVE rule prohibits this combination of parties. Nothing was recorded.' });
      }
      if (result.outcome === 'PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED') {
        return snapshotAndRefuse(complianceStateFrom({ outcome: result.outcome, reasons: result.reasons, consentsOutstanding: result.consentsOutstanding, representationCount: live.length, partiesConfirmed: partiesConfirmed(tx) }),
          { error: 'CONSENT_REQUIRED', consentsOutstanding: result.consentsOutstanding, reasons: result.reasons.filter((r) => r.code === 'CONSENT_REQUIRED'), policyVersions: result.policyVersions, outcome: result.outcome, contextId: ctx.id, message: 'Prior, party-specific written consent is outstanding. Request it; nothing was recorded.' });
      }
      // A stale rev rolls the evaluation back with the rest (S11b-2's rule).
      guardRevOrRollback(req, res, tx, TX_CONFLICT(tx));
      const needsReview = result.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED' || result.outcome === 'INSUFFICIENT_DATA';
      const reviewReasons = result.reasons.filter((r) => r.code !== 'FACET_VERIFIED');
      const snapshot = { outcome: result.outcome, evaluationId: result.evaluationId, evaluatedAt: result.evaluatedAt };
      if (needsReview && !declaredOnly) {
        // No binding is recorded: the binding the caller asked for does not
        // exist, and a review item exists instead.
        const review = compliance.createReview({ kind: 'conflict_evaluation', agencyOrgId: tx.agencyOrgId, agentUserId: req.orgUser.id, subject: { contextId: ctx.id, transactionId: tx.id, partyRole }, reasons: reviewReasons, policyVersions: result.policyVersions, snapshot, requestedBy: byAgent(req) });
        return snapshotAndRefuse(complianceStateFrom({ outcome: result.outcome, reasons: result.reasons, representationCount: live.length, partiesConfirmed: partiesConfirmed(tx) }),
          { error: 'REGULATORY_REVIEW_REQUIRED', reasons: review.reasons, policyVersions: result.policyVersions, outcome: result.outcome, contextId: ctx.id, message: 'The deciding rule\'s operative status is uncertain or not encoded. An attributed review item was created; nothing proceeds until it is resolved under a named policy version.' });
      }
      const repId = nextId('txr');
      let reviewId = null;
      if (declaredOnly) {
        reviewId = compliance.createReview({ kind: 'representation_declared', agencyOrgId: tx.agencyOrgId, agentUserId: req.orgUser.id, subject: { contextId: ctx.id, transactionId: tx.id, representationId: repId, partyRole }, reasons: reviewReasons, policyVersions: result.policyVersions, snapshot, requestedBy: byAgent(req) }).id;
      }
      const rep = {
        id: repId, transactionId: tx.id, agencyOrgId: tx.agencyOrgId, agentUserId: req.orgUser.id, partyRole,
        agreementId: agreement?.id ?? null, declaredOnly, scope, jurisdictions, status: declaredOnly ? 'pending_review' : 'verified',
        reviewId, createdAt: now(), verifiedAt: declaredOnly ? null : now(), verifiedByReviewId: null, firstActAt: declaredOnly ? null : now(), withdrawnAt: null, withdrawnReason: null,
        keys: key ? { attach: { key, fp } } : {}, rev: 1, revAt: now(), revBy: null, history: [],
      };
      hist(rep, 'transaction_representation_attached', byAgent(req), { partyRole, status: rep.status, policyVersions: result.policyVersions });
      repsRepo.create(rep);
      txs.update(tx.id, (d) => {
        hist(d, 'transaction_representation_attached', byAgent(req), { partyRole, status: rep.status });
        recheckCompliance(d, byAgent(req));
        bumpTxRev(d, byAgent(req));
      });
      // A declared-only binding is RECORDED and NOT EFFECTIVE. It answers 422 with
      // the review it created rather than 201, for the same reason P5.6C does: a
      // 201 reads as "this is now in force", and it is not — an attributed
      // reviewer has to confirm it first (DR-18).
      if (declaredOnly) {
        return () => sendTransactionError(res, { error: 'REGULATORY_REVIEW_REQUIRED', reasons: reviewReasons, policyVersions: result.policyVersions, outcome: result.outcome, contextId: ctx.id, partyRole, message: 'Representation of an entity with no ScoutBox agreement is recorded as declared and needs attributed review. It is not effective until a named reviewer confirms it.' }, 'representations');
      }
      const stored = txById(tx.id);
      return () => res.status(201).json({ transaction: projectTransaction(stored, agentViewer(req)), representation: { id: rep.id, partyRole, status: rep.status } });
    });
  });

  orgRouter.post('/agent/transactions/:id/representations/:rid/withdraw', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    if (!writableOr(res, tx, 'representations')) return;
    const rep = repsOf(tx.id).find((r) => r.id === req.params.rid && r.agentUserId === req.orgUser.id);
    if (!rep) return notFound(res, 'representations');
    if (rep.status === 'withdrawn') return res.json({ transaction: projectTransaction(tx, agentViewer(req)), idempotent: true });
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      repsRepo.update(rep.id, (x) => {
        x.status = 'withdrawn'; x.withdrawnAt = now(); x.withdrawnReason = 'agent_withdrew';
        hist(x, 'transaction_representation_withdrawn', byAgent(req), { partyRole: x.partyRole });
        bumpTxRev(x, byAgent(req));
      });
      txs.update(tx.id, (d) => {
        hist(d, 'transaction_representation_withdrawn', byAgent(req), { partyRole: rep.partyRole });
        recheckCompliance(d, byAgent(req));
        bumpTxRev(d, byAgent(req));
      });
      const stored = txById(tx.id);
      return () => res.json({ transaction: projectTransaction(stored, agentViewer(req)) });
    });
  });

  orgRouter.post('/agent/transactions/:id/evaluate', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    if (!writableOr(res, tx, 'evaluate')) return;
    if (limitedOr429(res, 'transaction_write', req.orgUser.id)) return;
    inUnit(() => {
      txs.update(tx.id, (d) => { recheckCompliance(d, byAgent(req)); bumpTxRev(d, byAgent(req)); });
      const stored = txById(tx.id);
      return () => res.json({ transaction: projectTransaction(stored, agentViewer(req)) });
    });
  });

  /**
   * An actor-requested status transition. Only the representing agent may
   * request one, only through ACTOR_TRANSITIONS, and a move INTO the live
   * workflow (ACTIVE) additionally requires a compliance snapshot that is
   * clear AND current — recomputed in this request, not read from the page the
   * caller was looking at (§28, adversarial 11, 25, 26).
   */
  orgRouter.post('/agent/transactions/:id/status', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    const b = req.body ?? {};
    if (typeof b.to !== 'string' || !TRANSACTION_STATUSES.includes(b.to)) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'to', allowed: TRANSACTION_STATUSES }, 'status');
    const to = b.to;
    if (tx.status === 'ARCHIVED') return sendTransactionError(res, { error: 'TRANSACTION_ARCHIVED', status: tx.status, message: 'An archived transaction is read-only.' }, 'status');
    const guard = safeguardingProblem(tx);
    // ARCHIVED is the one transition a safeguarding stop must not prevent:
    // shelving a record the workspace can no longer act on is the safe move.
    if (guard && to !== 'ARCHIVED') return sendTransactionError(res, { error: 'TRANSACTION_PARTY_UNAVAILABLE', message: 'A party to this transaction is no longer available to your organisation. It can be archived; it cannot be progressed.' }, 'status');
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    const reasonCode = text(b.reasonCode, 60);
    const reason = text(b.reason, TRANSACTION_LIMITS.reason);
    if (reasonCode === undefined) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'reasonCode', message: 'reasonCode must be text.' }, 'status');
    if (reason === undefined) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'reason', message: 'reason must be text.' }, 'status');
    const fp = payloadFingerprint({ to, reasonCode, reason });
    // The idempotency check comes BEFORE the transition check: a replay of a
    // transition that already happened must answer "already done", not "you
    // cannot do that from here" — which is what the caller would see, since the
    // transition it is replaying is exactly what moved the transaction.
    if (key && tx.keys[`status:${key}`]) { if (tx.keys[`status:${key}`].fp === fp) return res.json({ transaction: projectTransaction(tx, agentViewer(req)), idempotent: true }); return sendTransactionError(res, { error: 'TRANSACTION_IDEMPOTENCY_CONFLICT' }, 'status'); }
    if (!actorTransitionAllowed(tx.status, to)) return sendTransactionError(res, { error: 'TRANSACTION_TRANSITION_NOT_ALLOWED', from: tx.status, to, allowed: ACTOR_TRANSITIONS[tx.status] ?? [], message: 'That is not a transition this transaction can make from its current state.' }, 'status');
    if (limitedOr429(res, 'transaction_status_write', req.orgUser.id)) return;
    if (to === 'PARTIES_CONFIRMED') {
      if (!partiesConfirmed(tx)) return sendTransactionError(res, { error: 'TRANSACTION_PARTIES_NOT_CONFIRMED', awaiting: partiesAwaitingConfirmation(tx), message: 'Every required party must confirm its own participation first. Naming a party is not confirming it.' }, 'status');
    }
    // A reason code is the vocabulary of the move it explains: a hold, a cancellation or a closure needs one of its own,
    // and a move that takes none is refused one (S11c: it used to be recorded unread).
    const codes = REASON_CODES_FOR[to] ?? null;
    if (codes ? !codes.includes(reasonCode) : reasonCode !== '') return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'reasonCode', allowed: codes ?? [], ...(codes ? {} : { message: `A move to ${to} takes no reason code.` }) }, 'status');
    inUnit(() => {
      if (to === 'ACTIVE') {
        // A stale snapshot authorises nothing (§27). Refusing FIRST — before the
        // re-check — is deliberate: it means the caller cannot enter the live
        // workflow on facts they have not seen, because they must re-evaluate and
        // read the new answer before asking again. The re-check below is the
        // second guard, not the only one. The flag and the entry commit with the refusal.
        const stale0 = stalenessOf(tx);
        if (stale0) {
          txs.update(tx.id, (d) => { d.reEvaluationPending = true; hist(d, 'transaction_compliance_stale', byAgent(req), { staleness: stale0 }); d.updatedAt = now(); bumpTxRev(d, byAgent(req)); });
          return () => sendTransactionError(res, { error: 'TRANSACTION_COMPLIANCE_STALE', staleness: stale0, message: 'The recorded compliance evaluation no longer matches the current facts. Re-evaluate and read the new answer before progressing.' }, 'status');
        }
        // Leaving a hold never resumes on trust (§19): compliance is re-checked
        // here, in this request, and the answer decides (and is recorded either way).
        let checked = null;
        const after = txs.update(tx.id, (d) => {
          checked = recheckCompliance(d, byAgent(req));
          if (checked.safeguarding) return;
          if (checked.state?.blocked || !checked.state?.clear || !actorTransitionAllowed(d.status, to)) { bumpTxRev(d, byAgent(req)); return; }
        });
        const { safeguarding, state } = checked;
        if (safeguarding) return () => notFound(res, 'status');
        if (state?.blocked) return () => sendTransactionError(res, { error: 'TRANSACTION_COMPLIANCE_BLOCKED', outcome: state.outcome, reasons: state.reasonCodes.map((code) => ({ code })), message: 'An encoded ACTIVE rule prohibits this combination. A reviewer cannot approve past it; only changed facts or a new policy version can.' }, 'status');
        if (!state?.clear) return () => sendTransactionError(res, { error: 'TRANSACTION_COMPLIANCE_PENDING', pendingReason: state?.pendingReason ?? null, outcome: state?.outcome ?? null, reasons: (state?.reasonCodes ?? []).map((code) => ({ code })), message: 'This transaction cannot progress while compliance is outstanding.' }, 'status');
        // Re-check the transition: the re-evaluation above may have moved the
        // status, and the caller's transition must still be legal from where the
        // transaction now is.
        if (!actorTransitionAllowed(after.status, to)) return () => sendTransactionError(res, { error: 'TRANSACTION_TRANSITION_NOT_ALLOWED', from: after.status, to, allowed: ACTOR_TRANSITIONS[after.status] ?? [] }, 'status');
      }
      // A stale rev rolls back the re-evaluation above with the rest (S11b-2's rule).
      guardRevOrRollback(req, res, tx, TX_CONFLICT(tx));
      let from = null;
      txs.update(tx.id, (d) => {
        from = d.status;
        d.status = to;
        if (key) d.keys[`status:${key}`] = { key, fp };
        if (to === 'ON_HOLD') { d.holdReasonCode = reasonCode; d.holdReason = reason || null; d.heldAt = now(); }
        if (to === 'ACTIVE') { d.holdReasonCode = null; d.holdReason = null; d.heldAt = null; }
        if (to === 'CANCELLED') { d.cancelReasonCode = reasonCode; d.cancelledAt = now(); }
        if (to === 'CLOSED') { d.closeReasonCode = reasonCode; d.closedAt = now(); }
        if (to === 'ARCHIVED') d.archivedAt = now();
        const action = to === 'ON_HOLD' ? 'transaction_held' : to === 'CANCELLED' ? 'transaction_cancelled' : to === 'CLOSED' ? 'transaction_closed' : to === 'ARCHIVED' ? 'transaction_archived' : 'transaction_status_changed';
        hist(d, action, byAgent(req), { from, to, ...(reasonCode ? { holdReasonCode: reasonCode } : {}) });
        d.updatedAt = now(); bumpTxRev(d, byAgent(req));
      });
      if (['CANCELLED', 'CLOSED'].includes(to)) {
        const ctx = compliance.contextById(tx.contextId);
        if (ctx) compliance.closeContext(ctx, byAgent(req));
      }
      // Literal event names, one call site each: the M18.2 registry audit reads
      // broadcast call sites textually, so a name that only ever appears inside a
      // ternary is a registered event the audit cannot see being emitted.
      const payload = { orgId: tx.agencyOrgId, txId: tx.id, status: to };
      if (to === 'ON_HOLD') broadcast('agent_transaction_held', payload);
      else if (to === 'CANCELLED') broadcast('agent_transaction_cancelled', payload);
      else if (to === 'CLOSED') broadcast('agent_transaction_closed', payload);
      else broadcast('agent_transaction_status_changed', payload);
      for (const p of partiesOf(tx).filter((x) => !x.removed)) {
        notifyParty(tx, p, 'agent_transaction', `A transaction you are party to is now "${to.replace(/_/g, ' ').toLowerCase()}". Nothing has been agreed or signed.`);
      }
      const stored = txById(tx.id);
      return () => res.json({ transaction: projectTransaction(stored, agentViewer(req)) });
    });
  });

  /**
   * Request a party's consent from inside the workspace. Delegates to the
   * P5.6C ledger through the SAME function its own route uses: there is one
   * set of rules about when a consent may exist and one place it is recorded.
   */
  orgRouter.post('/agent/transactions/:id/consents/request', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    if (!writableOr(res, tx, 'consents')) return;
    const ctx = compliance.contextById(tx.contextId);
    if (!ctx) return notFound(res, 'consents');
    // The projection is the context's evaluation input, rebuilt from the transaction's own rows (its own write); the
    // consent route then runs its own unit and answers only after it committed.
    compliance.project(ctx, { parties: partiesOf(tx), representations: liveRepsOf(tx.id) });
    compliance.requestConsent(req, res, ctx);
  });

  /**
   * Record a terms version (§93 "terms as data", P5.6A DR-38's reserved
   * `transactionTerms` shape). Data only: ScoutBox does not validate a fee, a
   * cap or a duration, does not propose, does not accept and does not value —
   * because validating a suspended rule would be wrong and proposing would
   * make ScoutBox the negotiator (P5.6A DR-31, mandate §37).
   */
  orgRouter.post('/agent/transactions/:id/terms', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    if (!writableOr(res, tx, 'terms')) return;
    if (limitedOr429(res, 'transaction_write', req.orgUser.id)) return;
    const b = req.body ?? {};
    const summary = text(b.summary, TRANSACTION_LIMITS.note);
    if (!summary) return sendTransactionError(res, { error: 'TERMS_INPUT_INVALID', field: 'summary', message: 'A terms version needs a written summary of what the parties recorded.' }, 'terms');
    if (typeof b.recordedFor !== 'string' || !PARTY_ROLES.includes(b.recordedFor)) return sendTransactionError(res, { error: 'TERMS_INPUT_INVALID', field: 'recordedFor', allowed: PARTY_ROLES }, 'terms');
    const roles = roomRolesFor(tx, agentViewer(req));
    const visibility = typeof b.visibility === 'string' ? b.visibility : '';
    if (!uploadableVisibilities(roles).includes(visibility)) return sendTransactionError(res, { error: 'DOCUMENT_VISIBILITY_NOT_PERMITTED', visibility: visibility || null, allowed: uploadableVisibilities(roles) }, 'terms');
    if (tx.terms.versions.length >= TRANSACTION_LIMITS.termsVersions) return sendTransactionError(res, { error: 'TERMS_INPUT_INVALID', field: 'summary', message: 'This transaction already holds the maximum number of recorded terms versions.' }, 'terms');
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      txs.update(tx.id, (d) => {
        const v = { id: nextId('txt'), at: now(), by: byAgent(req), recordedFor: b.recordedFor, visibility, summary, version: d.terms.versions.length + 1 };
        d.terms.versions.push(v);
        hist(d, 'transaction_terms_recorded', byAgent(req), { partyRole: b.recordedFor, visibility, version: v.version });
        d.updatedAt = now(); bumpTxRev(d, byAgent(req));
      });
      const stored = txById(tx.id);
      return () => res.status(201).json({ transaction: projectTransaction(stored, agentViewer(req)) });
    });
  });

  /** Reference an Opportunity this transaction came from (§49). By reference; the opportunity is not mutated. */
  orgRouter.post('/agent/transactions/:id/links', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    if (!writableOr(res, tx, 'links')) return;
    const opportunityId = idText(req.body?.opportunityId);
    if (!opportunityId) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'opportunityId' }, 'links');
    const opp = scoutingReads.opportunities.byId(opportunityId); // S9d: read through SQL
    // A link to an opportunity the agent cannot see would disclose that it
    // exists, so an unknown and an invisible opportunity answer alike.
    const engaging = partiesOf(tx).find((p) => !p.removed && p.partyRole === 'engaging_entity');
    if (!opp || !engaging || opp.orgId !== engaging.subjectId) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'opportunityId', message: 'No opportunity of the engaging club matches that reference.' }, 'links');
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      txs.update(tx.id, (d) => {
        d.links.opportunityId = opp.id;
        hist(d, 'transaction_status_changed', byAgent(req), { from: d.status, to: d.status });
        d.updatedAt = now(); bumpTxRev(d, byAgent(req));
      });
      const stored = txById(tx.id);
      return () => res.json({ transaction: projectTransaction(stored, agentViewer(req)) });
    });
  });

  // ============================================================ documents

  /**
   * Add a document to the workspace. This module stores NO bytes (§31, §82):
   * `evidenceRef` points at a record in the canonical evidence vault, and a
   * document without one is a placeholder that says so rather than a file that
   * does not exist. There is exactly one upload path in ScoutBox and this is
   * not a second one.
   */
  function addDocument(req, res, tx, { roles, partyRole, owner, by, rateKey }) {
    if (!writableOr(res, tx, 'documents')) return;
    if (limitedOr429(res, 'transaction_document_write', rateKey)) return;
    const b = req.body ?? {};
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    const label = text(b.label, TRANSACTION_LIMITS.label);
    if (typeof b.documentType !== 'string' || !DOCUMENT_TYPES.includes(b.documentType)) return sendTransactionError(res, { error: 'DOCUMENT_INPUT_INVALID', field: 'documentType', allowed: DOCUMENT_TYPES }, 'documents');
    const documentType = b.documentType;
    const allowed = uploadableVisibilities(roles, partyRole);
    const visibility = typeof b.visibility === 'string' ? b.visibility : '';
    if (!allowed.includes(visibility)) return sendTransactionError(res, { error: 'DOCUMENT_VISIBILITY_NOT_PERMITTED', visibility: visibility || null, allowed, message: 'You cannot file a document into a lane you do not sit in, and nobody may file into the Trust & Safety lane.' }, 'documents');
    if (!label) return sendTransactionError(res, { error: 'DOCUMENT_INPUT_INVALID', field: 'label', message: 'A document needs a label the other parties can read.' }, 'documents');
    let evidenceRef = null;
    if (b.evidenceRef != null) {
      const ref = b.evidenceRef;
      const shapeOk = typeof ref === 'object' && !Array.isArray(ref) && ref.kind === 'verification_evidence' && typeof ref.id === 'string' && ref.id.trim() && ref.id.trim().length <= ID_MAX;
      if (!shapeOk) return sendTransactionError(res, { error: 'DOCUMENT_INPUT_INVALID', field: 'evidenceRef', allowed: ['verification_evidence'], message: 'A document reference is { kind: "verification_evidence", id } naming a record in the canonical evidence vault.' }, 'documents');
      const ev = rawCtx.verificationReads.evidence.byId(ref.id.trim());
      // The uploader must own the evidence: a reference is not a way to reach
      // someone else's file, and an unknown id and a foreign id answer alike.
      const mine = ev && ((owner.kind === 'club' && ev.orgId === owner.id) || (owner.kind === 'player' && ev.playerId === owner.id) || (owner.kind === 'agent' && ev.orgId === tx.agencyOrgId));
      if (!ev || !mine) return sendTransactionError(res, { error: 'DOCUMENT_INPUT_INVALID', field: 'evidenceRef', message: 'No evidence record of yours matches that reference.' }, 'documents');
      evidenceRef = { kind: 'verification_evidence', id: ev.id };
    }
    // M23 P5.7: an integer timestamp, an ISO 8601 instant with an offset, or a
    // calendar day (valid through that day) — never a coerced numeric string.
    const expP = isAbsent(b.expiresAt) ? null : parseDateOrInstant(b.expiresAt, { dayEdge: 'end' });
    if (expP && !expP.ok) return sendTransactionError(res, { error: 'DOCUMENT_INPUT_INVALID', field: 'expiresAt', message: `An expiry must be a timestamp, an ISO 8601 date-time with an offset, or a calendar day (${expP.why}).` }, 'documents');
    const expiresAt = expP ? expP.ms : null;
    if (expiresAt !== null && expiresAt <= now()) return sendTransactionError(res, { error: 'DOCUMENT_INPUT_INVALID', field: 'expiresAt', message: 'An expiry must be a future timestamp.' }, 'documents');
    const fp = payloadFingerprint({ documentType, visibility, label, evidenceRef });
    if (key) {
      const hit = docsRepo.byAddKey(tx.id, key);
      if (hit) { if (hit.keys.add.fp === fp) return res.json({ document: documentView(hit, roles, partyRole), idempotent: true }); return sendTransactionError(res, { error: 'TRANSACTION_IDEMPOTENCY_CONFLICT' }, 'documents'); }
    }
    if (docsRepo.liveCount(tx.id) >= TRANSACTION_LIMITS.documents) return sendTransactionError(res, { error: 'DOCUMENT_INPUT_INVALID', field: 'documentType', message: 'This transaction already holds the maximum number of documents.' }, 'documents');
    inUnit(() => {
      const d = {
        id: nextId('txd'), transactionId: tx.id, documentType, visibility, label, version: 1,
        owner, ownerPartyRole: partyRole, uploadedBy: by, createdAt: now(),
        expiresAt, evidenceRef, supersedes: null, supersededBy: null, removedAt: null,
        keys: key ? { add: { key, fp } } : {}, rev: 1, revAt: now(), revBy: null, history: [],
      };
      hist(d, 'transaction_document_added', by, { documentType, visibility, version: 1 });
      const stored = docsRepo.create(d);
      txs.update(tx.id, (x) => { hist(x, 'transaction_document_added', by, { documentType, visibility }); x.updatedAt = now(); });
      broadcast('agent_transaction_document_added', { orgId: tx.agencyOrgId, txId: tx.id, docId: d.id });
      // Only the parties the CLASS admits hear about it: a notification is a
      // disclosure, and an AGENT_PRIVATE document discloses nothing to anyone.
      if (visibility !== 'AGENT_PRIVATE') {
        for (const p of partiesOf(tx).filter((x) => !x.removed)) {
          const otherRoles = p.subjectKind === 'player' ? ['party_individual'] : ['party_club_signatory'];
          if (!canSeeVisibility(visibility, otherRoles, p.partyRole)) continue;
          if (p.subjectKind === 'player' && owner.kind === 'player' && p.subjectId === owner.id) continue;
          if (p.subjectKind === 'club' && owner.kind === 'club' && p.subjectId === owner.id) continue;
          notifyParty(tx, p, 'agent_transaction', `A document has been shared in a transaction you are party to: ${label}.`);
        }
        if (owner.kind !== 'agent') notify({ kind: 'org_user', id: tx.agentUserId }, 'agent_transaction', `A party shared a document in a transaction: ${label}.`, tx.id);
      }
      return () => res.status(201).json({ document: documentView(stored, roles, partyRole) });
    });
  }

  /** Read a document's reference. Reauthorized every time (§80): a reference is never a standing permission. */
  function readDocumentReference(req, res, tx, { roles, partyRole }) {
    const d = docsOf(tx.id).find((x) => x.id === req.params.docId);
    if (!d || !canSeeVisibility(d.visibility, roles, partyRole)) return sendTransactionError(res, { error: 'DOCUMENT_NOT_FOUND', message: 'No document with that reference is available to you.' }, 'documents');
    if (isExpiredAt(d.expiresAt, now())) return sendTransactionError(res, { error: 'DOCUMENT_NOT_FOUND', message: 'No document with that reference is available to you.' }, 'documents');
    if (!d.evidenceRef) return res.json({ document: documentView(d, roles, partyRole), reference: null, note: 'This document is a placeholder: no file has been attached to it in the evidence vault.' });
    res.json({
      document: documentView(d, roles, partyRole),
      reference: d.evidenceRef,
      note: 'Fetch the file through the canonical evidence route, which authorises the download itself. Holding this reference is not authority to read the file.',
    });
  }

  orgRouter.get('/agent/transactions/:id/documents', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id); if (!tx) return;
    const roles = roomRolesFor(tx, agentViewer(req));
    res.json({ items: docsOf(tx.id).filter((d) => canSeeVisibility(d.visibility, roles)).map((d) => documentView(d, roles)), documentTypes: DOCUMENT_TYPES, uploadable: uploadableVisibilities(roles) });
  });
  orgRouter.post('/agent/transactions/:id/documents', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    addDocument(req, res, tx, { roles: roomRolesFor(tx, agentViewer(req)), partyRole: null, owner: { kind: 'agent', id: req.orgUser.id }, by: byAgent(req), rateKey: req.orgUser.id });
  });
  orgRouter.get('/agent/transactions/:id/documents/:docId/reference', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id); if (!tx) return;
    readDocumentReference(req, res, tx, { roles: roomRolesFor(tx, agentViewer(req)), partyRole: null });
  });
  /** A new version supersedes the old one; the old row is kept, never edited but for its link (§32 version). */
  orgRouter.post('/agent/transactions/:id/documents/:docId/supersede', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    if (!writableOr(res, tx, 'documents')) return;
    const old = docsOf(tx.id).find((x) => x.id === req.params.docId);
    const roles = roomRolesFor(tx, agentViewer(req));
    if (!old || old.owner?.kind !== 'agent' || !canSeeVisibility(old.visibility, roles)) return sendTransactionError(res, { error: 'DOCUMENT_NOT_FOUND' }, 'documents');
    if (old.supersededBy) return sendTransactionError(res, { error: 'DOCUMENT_SUPERSEDED', message: 'That version has already been superseded.' }, 'documents');
    const given = text(req.body?.label, TRANSACTION_LIMITS.label);
    if (given === undefined) return sendTransactionError(res, { error: 'DOCUMENT_INPUT_INVALID', field: 'label', message: 'label must be text.' }, 'documents');
    const label = given || old.label;
    if (!guardRev(req, res, old, { errorCode: 'DOCUMENT_VERSION_CONFLICT', current: { version: old.version } })) return;
    inUnit(() => {
      const d = {
        id: nextId('txd'), transactionId: tx.id, documentType: old.documentType, visibility: old.visibility, label, version: old.version + 1,
        owner: old.owner, ownerPartyRole: old.ownerPartyRole, uploadedBy: byAgent(req), createdAt: now(), expiresAt: old.expiresAt,
        evidenceRef: old.evidenceRef, supersedes: old.id, supersededBy: null, removedAt: null, keys: {}, rev: 1, revAt: now(), revBy: null, history: [],
      };
      hist(d, 'transaction_document_added', byAgent(req), { documentType: d.documentType, visibility: d.visibility, version: d.version });
      const stored = docsRepo.create(d);
      docsRepo.update(old.id, (x) => {
        x.supersededBy = d.id;
        hist(x, 'transaction_document_superseded', byAgent(req), { version: x.version });
        bumpTxRev(x, byAgent(req));
      });
      txs.update(tx.id, (x) => { hist(x, 'transaction_document_superseded', byAgent(req), { documentType: d.documentType, version: d.version }); x.updatedAt = now(); });
      return () => res.status(201).json({ document: documentView(stored, roles) });
    });
  });

  // ============================================================ notes

  /**
   * A scoped note (§35). Notes carry the SAME visibility classes as documents,
   * so there is one vocabulary rather than two, and no global notes bucket
   * exists: every note names the lane it belongs to and is absent — not
   * redacted — for anyone that lane excludes.
   */
  function addNote(req, res, tx, { roles, partyRole, by, rateKey }) {
    if (!writableOr(res, tx, 'notes')) return;
    if (limitedOr429(res, 'transaction_note_write', rateKey)) return;
    const noteText = text(req.body?.text, TRANSACTION_LIMITS.note);
    if (!noteText) return sendTransactionError(res, { error: 'NOTE_INPUT_INVALID', field: 'text' }, 'notes');
    const visibility = typeof req.body?.visibility === 'string' ? req.body.visibility : '';
    const allowed = uploadableVisibilities(roles, partyRole).filter((v) => NOTE_VISIBILITY.includes(v));
    if (!allowed.includes(visibility)) return sendTransactionError(res, { error: 'DOCUMENT_VISIBILITY_NOT_PERMITTED', visibility: visibility || null, allowed }, 'notes');
    if (tx.notes.length >= TRANSACTION_LIMITS.notes) return sendTransactionError(res, { error: 'NOTE_INPUT_INVALID', field: 'text', message: 'This transaction already holds the maximum number of notes.' }, 'notes');
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      const n = { id: nextId('txn'), visibility, text: noteText, by, at: now() };
      txs.update(tx.id, (d) => {
        d.notes.push(n);
        hist(d, 'transaction_note_added', by, { visibility });
        d.updatedAt = now(); bumpTxRev(d, by);
      });
      return () => res.status(201).json({ note: { id: n.id, visibility: n.visibility, text: n.text, at: n.at, actor: actorLabel(n.by) } });
    });
  }

  orgRouter.post('/agent/transactions/:id/notes', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    addNote(req, res, tx, { roles: roomRolesFor(tx, agentViewer(req)), partyRole: null, by: byAgent(req), rateKey: req.orgUser.id });
  });

  // ============================================================ timeline

  orgRouter.get('/agent/transactions/:id/timeline', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id); if (!tx) return;
    const roles = roomRolesFor(tx, agentViewer(req));
    res.json({ items: timelineFor(tx, roles), note: 'The timeline is what YOU may see of what happened. The platform audit holds more operational detail and is not this.' });
  });

  orgRouter.get('/agent/transactions/:id/messages', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id); if (!tx) return;
    const viewer = agentViewer(req);
    res.json({
      items: tx.linkedThreads.map((t) => ({ id: t.id, channelId: t.channelId, linkedAt: t.linkedAt, actor: actorLabel(t.linkedBy), readable: channelReadableBy(t.channelId, viewer) })),
      note: 'Correspondence lives in the canonical ScoutBox Inbox. A link records that a conversation exists and who shared it; reading it still needs the Inbox\'s own authorisation, which transaction membership alone does not give. ScoutBox never negotiates and never replies for anyone.',
    });
  });

  // ============================================================ CLUB lane

  orgRouter.get('/transactions', (req, res) => {
    if (req.org.type !== 'club') return res.json({ items: [], nextCursor: null, note: 'Transaction party lanes are for club organisations.' });
    let pageReq; try { pageReq = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
    const viewer = clubViewer(req);
    // Newest first, by cursor: a club's list grows with every transaction it is named in.
    const { records, nextCursor } = pageItems(txs.clubPage({ orgId: req.org.id, ...pageReq }).rows, pageReq.limit);
    const batch = batchFor(records);
    res.json({
      items: records.map((t) => projectTransaction(t, viewer, batch)), nextCursor,
      signatory: viewer.signatory, statuses: TRANSACTION_STATUSES,
      documentTypes: DOCUMENT_TYPES,
      note: viewer.signatory ? null : 'You can read the transactions this club is party to. Confirming the club\'s participation and answering a consent need a recorded club signatory.',
      honest: HONEST_TRANSACTION,
    });
  });
  orgRouter.get('/transactions/:id', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id); if (!tx) return;
    res.json({ transaction: projectTransaction(tx, clubViewer(req)), signatory: clubViewer(req).signatory });
  });
  /** The club confirms its own participation. Only a recorded signatory binds the club (§64). */
  orgRouter.post('/transactions/:id/confirm', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id, { signatory: true }); if (!tx) return;
    if (!writableOr(res, tx, 'confirm')) return;
    if (limitedOr429(res, 'transaction_status_write', req.orgUser.id)) return;
    const party = partiesOf(tx).find((p) => !p.removed && p.subjectKind === 'club' && p.subjectId === req.org.id);
    if (!party) return notFound(res, 'confirm');
    if (party.confirmedAt) return res.json({ transaction: projectTransaction(tx, clubViewer(req)), idempotent: true });
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      txs.update(tx.id, (d) => {
        const p = d.parties.find((x) => x.id === party.id);
        p.confirmedAt = now(); p.confirmedBy = byClubUser(req);
        hist(d, 'transaction_party_confirmed', byClubUser(req), { partyRole: party.partyRole, subjectKind: 'club' });
        partyChanged(d, byClubUser(req));
        bumpTxRev(d, byClubUser(req));
      });
      broadcast('agent_transaction_party_changed', { orgId: tx.agencyOrgId, txId: tx.id, partyRole: party.partyRole });
      notify({ kind: 'org_user', id: tx.agentUserId }, 'agent_transaction', `A club confirmed its participation as the ${party.partyRole.replace(/_/g, ' ')} in a transaction.`, tx.id);
      const stored = txById(tx.id);
      return () => res.json({ transaction: projectTransaction(stored, clubViewer(req)) });
    });
  });
  orgRouter.get('/transactions/:id/documents', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id); if (!tx) return;
    const viewer = clubViewer(req); const roles = roomRolesFor(tx, viewer); const partyRole = req.txPartyRole;
    res.json({ items: docsOf(tx.id).filter((d) => canSeeVisibility(d.visibility, roles, partyRole) && !d.supersededBy).map((d) => documentView(d, roles, partyRole)), uploadable: uploadableVisibilities(roles, partyRole), documentTypes: DOCUMENT_TYPES });
  });
  orgRouter.post('/transactions/:id/documents', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id, { signatory: true }); if (!tx) return;
    addDocument(req, res, tx, { roles: roomRolesFor(tx, clubViewer(req)), partyRole: req.txPartyRole, owner: { kind: 'club', id: req.org.id }, by: byClubUser(req), rateKey: req.orgUser.id });
  });
  orgRouter.get('/transactions/:id/documents/:docId/reference', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id); if (!tx) return;
    readDocumentReference(req, res, tx, { roles: roomRolesFor(tx, clubViewer(req)), partyRole: req.txPartyRole });
  });
  orgRouter.post('/transactions/:id/notes', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id); if (!tx) return;
    addNote(req, res, tx, { roles: roomRolesFor(tx, clubViewer(req)), partyRole: req.txPartyRole, by: byClubUser(req), rateKey: req.orgUser.id });
  });
  orgRouter.get('/transactions/:id/timeline', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id); if (!tx) return;
    res.json({ items: timelineFor(tx, roomRolesFor(tx, clubViewer(req)), req.txPartyRole), note: 'The timeline is what this club may see of what happened.' });
  });
  /**
   * Link a canonical Inbox thread into the workspace. The linker must pass the
   * CHANNEL's own authorization — transaction membership is never enough (§81)
   * — and linking discloses only that a conversation exists.
   */
  orgRouter.post('/transactions/:id/messages/link', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id, { signatory: true }); if (!tx) return;
    if (!writableOr(res, tx, 'messages')) return;
    const channelId = idText(req.body?.channelId);
    if (channelId === undefined) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'channelId', message: 'channelId must be the id of a conversation, as text.' }, 'messages');
    const found = channelId ? channels.byId(channelId) : null;
    const ch = found && found.orgId === req.org.id ? found : null;
    const individual = partiesOf(tx).find((p) => !p.removed && p.partyRole === 'individual');
    if (!ch || !individual || ch.playerId !== individual.subjectId) return sendTransactionError(res, { error: 'MESSAGE_THREAD_NOT_FOUND', message: 'No conversation of yours with this transaction\'s individual matches that reference.' }, 'messages');
    if (tx.linkedThreads.some((t) => t.channelId === ch.id)) return res.json({ transaction: projectTransaction(tx, clubViewer(req)), idempotent: true });
    if (tx.linkedThreads.length >= TRANSACTION_LIMITS.linkedThreads) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'channelId', message: 'This transaction already links the maximum number of conversations.' }, 'messages');
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      txs.update(tx.id, (d) => {
        d.linkedThreads.push({ id: nextId('txm'), channelId: ch.id, linkedBy: byClubUser(req), linkedAt: now() });
        hist(d, 'transaction_message_linked', byClubUser(req), { count: d.linkedThreads.length });
        d.updatedAt = now(); bumpTxRev(d, byClubUser(req));
      });
      broadcast('agent_transaction_message_linked', { orgId: tx.agencyOrgId, txId: tx.id });
      const stored = txById(tx.id);
      return () => res.status(201).json({ transaction: projectTransaction(stored, clubViewer(req)) });
    });
  });
  /** Reference a trial of THIS club for THIS individual (§50). A reference only; no assessment crosses. */
  orgRouter.post('/transactions/:id/links', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id, { signatory: true }); if (!tx) return;
    if (!writableOr(res, tx, 'links')) return;
    const trialId = idText(req.body?.trialId);
    if (trialId === undefined) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'trialId', message: 'trialId must be the id of a trial, as text.' }, 'links');
    const individual = partiesOf(tx).find((p) => !p.removed && p.partyRole === 'individual');
    const foundTrial = trialId ? recruitmentReads.trials.byId(trialId) : null;
    const trial = foundTrial && foundTrial.orgId === req.org.id && individual && foundTrial.playerId === individual.subjectId ? foundTrial : null;
    if (!trial) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'trialId', message: 'No trial of yours with this transaction\'s individual matches that reference.' }, 'links');
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      txs.update(tx.id, (d) => {
        d.links.trialId = trial.id;
        hist(d, 'transaction_status_changed', byClubUser(req), { from: d.status, to: d.status });
        d.updatedAt = now(); bumpTxRev(d, byClubUser(req));
      });
      const stored = txById(tx.id);
      return () => res.json({ transaction: projectTransaction(stored, clubViewer(req)) });
    });
  });

  // ============================================================ PLAYER lane

  playerRouter.get('/transactions', (req, res) => {
    if (req.playerIsMinor) return res.json({ items: [], minor: true, note: 'Agent transactions are not available for under-18 accounts in ScoutBox.' });
    const viewer = playerViewer(req);
    // A per-player list: not paged.
    const mine = txs.forPlayer(req.player.id);
    const batch = batchFor(mine);
    res.json({ items: mine.map((t) => projectTransaction(t, viewer, batch)), statuses: TRANSACTION_STATUSES, honest: HONEST_TRANSACTION });
  });
  playerRouter.get('/transactions/:id', (req, res) => {
    const tx = playerTransaction(req, res, req.params.id); if (!tx) return;
    res.json({ transaction: projectTransaction(tx, playerViewer(req)) });
  });
  /** The individual confirms their own participation. Nobody confirms for them (§65). */
  playerRouter.post('/transactions/:id/confirm', (req, res) => {
    const tx = playerTransaction(req, res, req.params.id); if (!tx) return;
    if (!writableOr(res, tx, 'confirm')) return;
    if (limitedOr429(res, 'transaction_status_write', req.player.id)) return;
    const party = partiesOf(tx).find((p) => !p.removed && p.subjectKind === 'player' && p.subjectId === req.player.id);
    if (!party) return notFound(res, 'confirm');
    if (party.confirmedAt) return res.json({ transaction: projectTransaction(tx, playerViewer(req)), idempotent: true });
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      txs.update(tx.id, (d) => {
        const p = d.parties.find((x) => x.id === party.id);
        p.confirmedAt = now(); p.confirmedBy = byPlayer(req);
        hist(d, 'transaction_party_confirmed', byPlayer(req), { partyRole: party.partyRole, subjectKind: 'player' });
        partyChanged(d, byPlayer(req));
        bumpTxRev(d, byPlayer(req));
      });
      broadcast('agent_transaction_party_changed', { orgId: tx.agencyOrgId, txId: tx.id, partyRole: party.partyRole });
      notify({ kind: 'org_user', id: tx.agentUserId }, 'agent_transaction', 'Your client confirmed their participation in a transaction.', tx.id);
      const stored = txById(tx.id);
      return () => res.json({ transaction: projectTransaction(stored, playerViewer(req)) });
    });
  });
  playerRouter.get('/transactions/:id/documents', (req, res) => {
    const tx = playerTransaction(req, res, req.params.id); if (!tx) return;
    const roles = roomRolesFor(tx, playerViewer(req));
    res.json({ items: docsOf(tx.id).filter((d) => canSeeVisibility(d.visibility, roles, 'individual') && !d.supersededBy).map((d) => documentView(d, roles, 'individual')), uploadable: uploadableVisibilities(roles, 'individual'), documentTypes: DOCUMENT_TYPES });
  });
  playerRouter.post('/transactions/:id/documents', (req, res) => {
    const tx = playerTransaction(req, res, req.params.id); if (!tx) return;
    addDocument(req, res, tx, { roles: roomRolesFor(tx, playerViewer(req)), partyRole: 'individual', owner: { kind: 'player', id: req.player.id }, by: byPlayer(req), rateKey: req.player.id });
  });
  playerRouter.get('/transactions/:id/documents/:docId/reference', (req, res) => {
    const tx = playerTransaction(req, res, req.params.id); if (!tx) return;
    readDocumentReference(req, res, tx, { roles: roomRolesFor(tx, playerViewer(req)), partyRole: 'individual' });
  });
  playerRouter.get('/transactions/:id/timeline', (req, res) => {
    const tx = playerTransaction(req, res, req.params.id); if (!tx) return;
    res.json({ items: timelineFor(tx, roomRolesFor(tx, playerViewer(req)), 'individual'), note: 'The timeline is what you may see of what happened in this transaction.' });
  });

  // ============================================================ TRUST & SAFETY lane

  /**
   * Attributed Trust & Safety read. States, ids and party roles — never a
   * document's content, never a note, never a message, never a term. A
   * reviewer's job here is to see whether the platform's own rules were
   * applied, not to read the parties' papers.
   */
  const tsView = (tx, batch = null) => {
    const reps = batch ? batch.reps(tx.id) : repsOf(tx.id);
    const view = complianceOf(tx);
    return {
      id: tx.id, type: tx.type, status: tx.status, jurisdictions: tx.jurisdictions,
      agencyOrgId: tx.agencyOrgId, agentUserId: tx.agentUserId,
      parties: partiesOf(tx).map((p) => ({ partyRole: p.partyRole, subjectKind: p.subjectKind, removed: !!p.removed, confirmed: !!p.confirmedAt })),
      representations: reps.map((r) => ({ partyRole: r.partyRole, status: r.status, declaredOnly: !!r.declaredOnly, reviewId: r.reviewId ?? null })),
      compliance: view ? { outcome: view.outcome, pendingReason: view.pendingReason, blocked: view.blocked, clear: view.clear, reasonCodes: view.reasonCodes, policyVersions: view.policyVersions, evaluatedAt: view.evaluatedAt, stale: stalenessOf(tx, { view, reps }) } : null,
      reviews: compliance.reviewsForContext(tx.contextId),
      documentCount: (batch ? batch.docs(tx.id) : docsOf(tx.id)).length, noteCount: tx.notes.length, linkedThreadCount: tx.linkedThreads.length,
      createdAt: tx.createdAt, updatedAt: tx.updatedAt, rev: tx.rev,
    };
  };
  tsRouter.get('/transactions', (req, res) => {
    const status = statusFilterOr400(req, res); if (status === undefined) return;
    let pageReq; try { pageReq = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
    const { records, nextCursor } = pageItems(txs.allPage({ status, ...pageReq }).rows, pageReq.limit);
    const batch = batchFor(records);
    res.json({ items: records.map((t) => tsView(t, batch)), nextCursor, statuses: TRANSACTION_STATUSES, note: 'States, ids and party roles only. Transaction documents, notes, messages and terms are the parties\' and are not exposed here.' });
  });
  /** Process metrics only (§76): durations and counts. No agent is ranked and no player is ranked. */
  tsRouter.get('/transactions/metrics', (_req, res) => {
    const m = txs.metrics();
    const median = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
    const zeroFilled = (vocab, counts) => Object.fromEntries(vocab.map((k) => [k, counts[k] ?? 0]));
    const live = txs.live();
    const batch = batchFor(live);
    res.json({
      byStatus: zeroFilled(TRANSACTION_STATUSES, m.byStatus),
      byType: zeroFilled(TRANSACTION_TYPES, m.byType),
      medianDurationMs: median(m.durations),
      medianCompliancePendingMs: median(m.pendingSpans),
      medianConsentWaitMs: median(compliance.consentAnswerWaits()),
      cancellationReasons: zeroFilled(CANCEL_REASON_CODES, m.cancelReasons),
      holdReasons: zeroFilled(HOLD_REASON_CODES, m.holdReasons),
      staleSnapshots: live.filter((t) => stalenessOf(t, { reps: batch.reps(t.id) })).length,
      note: 'Process metrics only. No agent, club or player is ranked, and no subscription or payment status enters any transaction outcome.',
    });
  });
  // Registered BEFORE the `:id` route, or Express would read "metrics" as an id.
  tsRouter.get('/transactions/:id', (req, res) => {
    const tx = txById(req.params.id);
    if (!tx) return notFound(res, 'ts');
    res.json({ transaction: tsView(tx), audit: auditRows({ transactionId: tx.id }).slice(0, TRANSACTION_LIMITS.historyPage) });
  });

  // ============================================================ the audit
  const auditRows = (filter) => transactionAuditRows({ reads: agentTransactions.reads, snapshotOf: complianceOf }, filter);

  // ============================================================ lifecycle hooks

  /**
   * Player account removal (§71). The transaction keeps its shape — ids,
   * roles, states, times — and loses the person: the party row is tombstoned
   * and every actor label that named the player is emptied, inside the
   * deletion's unit. Nothing is resurrected into a list, because the projection
   * reads the live player record and finds none.
   */
  function onPlayerDeleted(playerId, at = now()) {
    agentTransactions.forgetPlayer(playerId, at, () => ({ id: nextId('aud'), at, action: 'transaction_subject_tombstoned', by: bySystem('account deletion'), detail: { partyRole: 'individual' } }));
  }

  /**
   * An attributed reviewer decided a declared-only binding (an entity client
   * with no ScoutBox agreement, P5.6A DR-18). The `transactionRepresentations`
   * row is the truth, so the decision lands here, inside the review's unit;
   * the compliance context's array is re-projected on the next evaluation.
   *
   * An approval records NO act by the agent: `firstActAt` stays null until the
   * agent themselves acts, so a later party-specific consent is still "in
   * advance" — the same rule P5.6C applies to its own review-verified rows.
   */
  function representationReviewed({ transactionId, representationId, outcome, by, reviewId }) {
    const tx = txById(transactionId);
    const rep = tx ? repsRepo.byId(representationId) : null;
    if (!tx || !rep || rep.transactionId !== transactionId || rep.status !== 'pending_review') return;
    const action = outcome === 'APPROVED' ? 'transaction_representation_attached' : 'transaction_representation_withdrawn';
    const next = repsRepo.update(rep.id, (x) => {
      if (outcome === 'APPROVED') { x.status = 'verified'; x.declaredOnly = false; x.verifiedAt = now(); x.verifiedByReviewId = reviewId; }
      else { x.status = 'withdrawn'; x.withdrawnAt = now(); x.withdrawnReason = 'review_rejected'; }
      hist(x, action, by, { partyRole: x.partyRole, status: x.status });
      bumpTxRev(x, by);
    });
    txs.update(tx.id, (d) => {
      hist(d, action, by, { partyRole: next.partyRole, status: next.status });
      if (LIVE_STATUSES.includes(d.status)) recheckCompliance(d, by);
      d.updatedAt = now();
    });
  }

  /**
   * M23 P6 — the ONE seam the Offer domain reads (P6 §11). A transaction is
   * "available to this Offer" only when the asking club is its ENGAGING
   * entity and the transaction is linked to exactly the recruitment case the
   * Offer is on; anything else answers null, so a club cannot learn that a
   * transaction exists by naming its id from an unrelated case. Readiness is
   * re-derived NOW from the live compliance snapshot and staleness — never
   * from anything the Offer stored. Read-only: no transaction is created,
   * moved or touched here, and no Offer is.
   */
  function offerReadinessFor(transactionId, { orgId, caseId } = {}) {
    if (typeof transactionId !== 'string' || !transactionId || !orgId || !caseId) return null;
    const tx = txById(transactionId);
    if (!tx) return null;
    if (clubPartyRoleOf(tx, orgId) !== 'engaging_entity') return null;
    if (tx.links.recruitmentCaseId !== caseId) return null;
    const view = complianceOf(tx);
    const readiness = offerReadiness(tx, { complianceState: view?.state ?? null, staleness: stalenessOf(tx, { view }) });
    return { tx: { id: tx.id, status: tx.status, type: tx.type ?? null }, readiness };
  }

  return {
    onPlayerDeleted, representationReviewed,
    hooks: { auditRows: (org) => auditRows({ agencyOrgId: org.id }) },
    transactionAuditRows: auditRows,
    offerReadinessFor,
  };
}
