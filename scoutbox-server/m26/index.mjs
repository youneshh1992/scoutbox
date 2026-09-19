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
 * THE FOUR SEPARATIONS, encoded rather than asserted:
 *
 *   transaction ≠ recruitment case  `db.recruitmentCases` is not imported,
 *                                   read or written anywhere in this file.
 *   transaction ≠ offer             no offer record, no offer state; only
 *                                   `offerReadiness()` — a boolean and its
 *                                   blockers.
 *   transaction ≠ signing           `db.signings` is not imported, read or
 *                                   written; no player contract state moves.
 *   compliance ≠ transaction        the verdict comes from the P5.6C engine
 *                                   through one narrow seam; this module owns
 *                                   no rule, no policy and no consent row.
 */

import { guardRev, bumpRev, revMeta } from '../m181/concurrency.mjs';
import { rateLimitedBody } from '../m181/rateLimit.mjs';
import { normaliseClientKey, payloadFingerprint } from '../m23/contact.mjs';
import { hasVerLevel } from '../m14/shared.mjs';
import { effectiveAgreementStatus, agreementGrantsAccess, affiliationActive, tiersOf, can } from '../m24/shared.mjs';
import { sendTransactionError, notFound } from './errors.mjs';
import { transactionAuditRows } from './audit.mjs';
import {
  TRANSACTION_TYPES, TRANSACTION_STATUSES, LIVE_STATUSES, TERMINAL_STATUSES, PARTY_ROLES, ROOM_ROLES,
  ACTOR_TRANSITIONS, ALL_TRANSITIONS, actorTransitionAllowed, complianceTransitionAllowed,
  DOCUMENT_TYPES, DOCUMENT_VISIBILITY, NOTE_VISIBILITY, canSeeVisibility, uploadableVisibilities,
  complianceStateFrom, statusForComplianceState, partyRevisionOf, snapshotStaleness, offerReadiness,
  requiredPartyRoles, partiesConfirmed, partiesAwaitingConfirmation, roomRolesFor, clubPartyRoleOf,
  timelineFor, timelineAudienceOf, actorLabel, HOLD_REASON_CODES, CANCEL_REASON_CODES, CLOSE_REASON_CODES,
  TRANSACTION_LIMITS, RELEASING_PARTY_TYPES, PENDING_REASONS,
} from './transaction.mjs';

const HONEST_TRANSACTION = 'A ScoutBox transaction is a permissioned workspace. "Ready" means ScoutBox currently permits this workflow to proceed under the encoded rules — it is not a statement of legal validity, no governing body has approved anything, no offer exists and nothing has been signed.';

export function registerTransactions(rawCtx) {
  const {
    db, orgRouter, playerRouter, tsRouter, nextId, persistNow, notify, broadcast,
    findPlayer, isBlocked, isAdult, orgCanSee, rateLimit, agent, compliance,
  } = rawCtx;

  // Registration-time presence (migration 2307 guarantees these; this is the
  // module-class belt to that brace, never a read-time repair). Declared here,
  // before the first route, so the M23 boot-contract rule holds.
  db.agentTransactions ??= [];
  db.transactionRepresentations ??= [];
  db.transactionDocuments ??= [];

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
  const str = (v, max) => String(v ?? '').trim().slice(0, max);

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

  const txById = (id) => db.agentTransactions.find((t) => t && t.id === id) ?? null;
  const repsOf = (txId) => db.transactionRepresentations.filter((r) => r && r.transactionId === txId);
  const docsOf = (txId) => db.transactionDocuments.filter((d) => d && d.transactionId === txId && !d.removedAt);
  const orgById = (id) => db.orgs.find((o) => o && o.id === id) ?? null;
  const activeAffiliationOf = (userId, orgId) => (db.agencyAffiliations ?? []).find((a) => a && a.userId === userId && a.agencyOrgId === orgId && affiliationActive(a, now())) ?? null;

  // ============================================================ compliance integration

  /**
   * The party/authority revision: the hash every staleness verdict is measured
   * against. Recomputed from LIVE records on every read and every write, never
   * cached, because a cached revision is exactly the stale fact it exists to
   * detect (§27).
   */
  function currentPartyRevision(tx) {
    const reps = repsOf(tx.id);
    const consents = tx.contextId ? compliance.consentsFor(tx.contextId) : [];
    const blocked = [];
    const minors = [];
    for (const p of tx.parties) {
      if (p.removed || p.subjectKind !== 'player') continue;
      const pl = findPlayer(p.subjectId);
      if (!pl) { blocked.push(p.subjectId); continue; }
      if (isBlocked(pl.id, tx.agencyOrgId)) blocked.push(pl.id);
      if (!isAdult(pl)) minors.push(pl.id);
    }
    return partyRevisionOf({
      parties: tx.parties, agentUserId: tx.agentUserId, representations: reps,
      consents: consents.map((k) => ({ id: k.id, status: k.status })),
      facetStates: compliance.facetStatesFor(tx.agentUserId) ?? {},
      policyVersions: tx.contextId ? (compliance.lastEvaluation(compliance.contextById(tx.contextId) ?? {})?.policyVersions ?? []) : [],
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
    for (const p of tx.parties) {
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
   * Re-evaluate compliance NOW and record the snapshot on the transaction.
   * Called on every material mutation and never trusted from a previous
   * request: this is what makes "an old evaluation authorises a new mutation"
   * impossible rather than guarded against (§28).
   */
  function recheckCompliance(tx, by, { record = true } = {}) {
    const ctx = tx.contextId ? compliance.contextById(tx.contextId) : null;
    const reps = repsOf(tx.id).filter((r) => r.status !== 'withdrawn');
    const confirmed = partiesConfirmed(tx);
    const guard = safeguardingProblem(tx);
    if (guard) {
      // Safeguarding is not a compliance verdict and must not be reported as
      // one: the transaction stops, the snapshot is not refreshed, and the
      // caller's refusal is the uniform 404.
      return { safeguarding: guard, state: null, result: null };
    }
    const gate = compliance.facetGateProblem(tx.agentUserId, tx.jurisdictions);
    if (gate) {
      const state = complianceStateFrom({ gate: gate.gate ?? 'FACET_NOT_VERIFIED', reasons: gate.reasons ?? [], partiesConfirmed: confirmed, representationCount: reps.length });
      if (record) applyComplianceSnapshot(tx, { state, result: null, ctx, by, partyRevision: currentPartyRevision(tx) });
      return { safeguarding: null, state, result: null, gateProblem: gate };
    }
    if (!ctx) return { safeguarding: null, state: complianceStateFrom({ gate: 'REPRESENTATION_MISSING', partiesConfirmed: confirmed }), result: null };
    compliance.project(ctx, { parties: tx.parties, representations: reps });
    const result = compliance.evaluate(ctx, by, { record });
    const state = complianceStateFrom({
      outcome: result.outcome, reasons: result.reasons, consentsOutstanding: result.consentsOutstanding,
      representationCount: reps.length, partiesConfirmed: confirmed,
    });
    if (record) applyComplianceSnapshot(tx, { state, result, ctx, by, partyRevision: currentPartyRevision(tx) });
    return { safeguarding: null, state, result };
  }

  /**
   * Attach the snapshot (§26) and let it move the status through the
   * COMPLIANCE transition map only. An actor can never reach READY,
   * COMPLIANCE_PENDING or COMPLIANCE_BLOCKED by asking.
   */
  function applyComplianceSnapshot(tx, { state, result, ctx, by, partyRevision }) {
    const prev = tx.compliance?.state ?? null;
    tx.compliance = {
      evaluationId: result ? `${ctx.id}#${(ctx.evaluations ?? []).length}` : `${tx.id}#gate`,
      contextId: ctx?.id ?? null,
      evaluatedAt: now(),
      policyVersions: result?.policyVersions ?? [],
      outcome: state.outcome, reasonCodes: state.reasonCodes,
      pendingReason: state.pendingReason, blocked: state.blocked, clear: state.clear,
      consentRequirements: (result?.consentsOutstanding ?? []).map((c) => ({ partyRole: c.partyRole, consentKind: c.consentKind, reasonCode: c.reasonCode })),
      verificationFreshness: compliance.facetStatesFor(tx.agentUserId)?.fifa_licence ?? null,
      partyRevision, state,
    };
    tx.reEvaluationPending = false;
    if (ctx) ctx.reEvaluationPending = false;
    const want = statusForComplianceState(state);
    if (want && want !== tx.status && complianceTransitionAllowed(tx.status, want)) {
      const from = tx.status;
      tx.status = want;
      hist(tx, 'transaction_status_changed', by ?? bySystem('compliance re-evaluation'), { from, to: want, pendingReason: state.pendingReason ?? null, outcome: state.outcome ?? null });
      broadcast('agent_transaction_status_changed', { orgId: tx.agencyOrgId, txId: tx.id, status: tx.status });
    }
    hist(tx, 'transaction_compliance_evaluated', by ?? bySystem('compliance re-evaluation'), { outcome: state.outcome ?? null, pendingReason: state.pendingReason ?? null, reasonCodes: state.reasonCodes, policyVersions: result?.policyVersions ?? [] });
    if (JSON.stringify(prev) !== JSON.stringify(state)) {
      broadcast('agent_transaction_compliance_updated', { orgId: tx.agencyOrgId, txId: tx.id, outcome: state.outcome ?? 'NONE' });
      notify({ kind: 'org_user', id: tx.agentUserId }, 'agent_transaction_compliance', state.blocked
        ? 'A transaction is blocked by an encoded ACTIVE rule. It cannot progress; only changed facts or a new policy version produce a different answer.'
        : state.clear ? 'A transaction is compliance-clear under the currently encoded rules. Nothing has been approved, agreed or signed.'
          : `A transaction cannot currently progress: ${String(state.pendingReason ?? 'compliance pending').replace(/_/g, ' ').toLowerCase()}.`, tx.id);
    }
    tx.updatedAt = now();
  }

  /** The staleness verdict for a READ: reported, never repaired, and never a clearance. */
  const stalenessOf = (tx) => snapshotStaleness(tx, currentPartyRevision(tx));

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
   * One transaction, projected for ONE viewer. Everything a party may see is
   * decided here from the roles the server derived; nothing is filtered in a
   * client. The derived convenience ids (`playerId`, `engagingOrgId`,
   * `releasingOrgId`) that mandate §6 asks for are computed from `parties[]`,
   * which stays the single truth — the frozen P5.6A §4 shape, and the only one
   * that can carry a party's confirmation and its history.
   */
  function projectTransaction(tx, viewer) {
    const roles = roomRolesFor(tx, viewer);
    const partyRole = viewer.kind === 'club' ? clubPartyRoleOf(tx, viewer.orgId) : viewer.kind === 'player' ? 'individual' : null;
    const stale = stalenessOf(tx);
    const state = tx.compliance?.state ?? null;
    const live = tx.parties.filter((p) => !p.removed);
    const isAgent = roles.includes('representing_agent');
    const reps = repsOf(tx.id);
    const consents = tx.contextId ? compliance.consentsFor(tx.contextId) : [];
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
      parties: tx.parties.map((p) => ({
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
       */
      compliance: state ? {
        outcome: state.outcome, pendingReason: state.pendingReason, blocked: state.blocked, clear: state.clear,
        reasonCodes: state.reasonCodes, consentRequirements: tx.compliance.consentRequirements ?? [],
        evaluatedAt: tx.compliance.evaluatedAt, stale: stale, staleness: stale,
        ...(isAgent ? { evaluationId: tx.compliance.evaluationId, contextId: tx.compliance.contextId, policyVersions: tx.compliance.policyVersions, verificationFreshness: tx.compliance.verificationFreshness } : {}),
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
      documents: docsOf(tx.id).filter((d) => canSeeVisibility(d.visibility, roles, partyRole) && !d.supersededBy).map((d) => documentView(d, roles, partyRole)),
      // Notes reuse the visibility classes; a note nobody may see is absent,
      // not redacted, so its existence is not disclosed either.
      notes: (tx.notes ?? []).filter((n) => !n.removedAt && canSeeVisibility(n.visibility, roles, partyRole)).map((n) => ({ id: n.id, visibility: n.visibility, text: n.text, at: n.at, actor: actorLabel(n.by) })),
      linkedThreads: (tx.linkedThreads ?? []).map((t) => ({ id: t.id, channelId: t.channelId, linkedAt: t.linkedAt, actor: actorLabel(t.linkedBy), readable: channelReadableBy(t.channelId, viewer) })),
      links: { trialId: tx.links?.trialId ?? null, opportunityId: tx.links?.opportunityId ?? null },
      terms: isAgent || roles.includes('party_club_signatory') || roles.includes('party_individual')
        ? { versions: (tx.terms?.versions ?? []).filter((v) => canSeeVisibility(v.visibility, roles, partyRole)).map((v) => ({ id: v.id, at: v.at, summary: v.summary, visibility: v.visibility, recordedFor: v.recordedFor, actor: actorLabel(v.by) })) }
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
    expiresAt: d.expiresAt ?? null, expired: typeof d.expiresAt === 'number' && d.expiresAt <= now(),
    signedAt: d.signedAt ?? null, supersedes: d.supersedes ?? null,
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
    const ch = (db.channels ?? []).find((c) => c && c.id === channelId);
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
    if (signatory && !hasVerLevel(db, req.org.id, req.orgUser.id, 'verification_admin')) {
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
    if (!tx || !tx.parties.some((p) => !p.removed && p.subjectKind === 'player' && p.subjectId === req.player.id)) { notFound(res, 'transaction'); return null; }
    return tx;
  }

  const clubViewer = (req) => ({ kind: 'club', orgId: req.org.id, userId: req.orgUser.id, signatory: hasVerLevel(db, req.org.id, req.orgUser.id, 'verification_admin') });
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

  // ============================================================ party resolution

  /**
   * Resolve one named party against LIVE records (§8: canonical ids, never
   * names). Uniform concealment: a player who does not exist, a minor, a
   * player the agency cannot see and a player who blocked the agency all
   * answer the same 404, so the route is not an age or a block oracle
   * (adversarial 23).
   */
  function resolveParty(req, res, raw, { type }) {
    const partyRole = String(raw?.partyRole ?? '');
    const subjectKind = String(raw?.subjectKind ?? '');
    const subjectId = String(raw?.subjectId ?? '');
    if (!PARTY_ROLES.includes(partyRole) || !['player', 'club'].includes(subjectKind) || !subjectId) {
      sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'parties', allowed: PARTY_ROLES, message: 'Each party needs partyRole (individual | engaging_entity | releasing_entity), subjectKind (player | club) and subjectId.' }, 'party');
      return null;
    }
    if (partyRole === 'releasing_entity' && !RELEASING_PARTY_TYPES.includes(type)) {
      sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'partyRole', message: 'A releasing entity exists only in a transfer or a loan.' }, 'party');
      return null;
    }
    if (subjectKind === 'player') {
      if (partyRole !== 'individual') { sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'partyRole', message: 'A player is the individual party.' }, 'party'); return null; }
      const pl = findPlayer(subjectId);
      if (!pl || !isAdult(pl) || !orgCanSee(req.org, pl) || isBlocked(pl.id, req.org.id)) { sendTransactionError(res, { error: 'TRANSACTION_PARTY_NOT_FOUND', message: 'No such party is available to you.' }, 'party'); return null; }
      return { id: nextId('txp'), partyRole, subjectKind, subjectId: pl.id, addedAt: now(), addedBy: byAgent(req), removed: false, removedAt: null, confirmedAt: null, confirmedBy: null, history: [] };
    }
    if (partyRole === 'individual') { sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'partyRole', message: 'A club is an engaging or a releasing entity.' }, 'party'); return null; }
    const org = orgById(subjectId);
    if (!org || org.type !== 'club') { sendTransactionError(res, { error: 'TRANSACTION_PARTY_NOT_FOUND', message: 'No such party is available to you.' }, 'party'); return null; }
    return { id: nextId('txp'), partyRole, subjectKind, subjectId: org.id, addedAt: now(), addedBy: byAgent(req), removed: false, removedAt: null, confirmedAt: null, confirmedBy: null, history: [] };
  }

  /** Notify a party that the workspace needs something from it. Ids and states only. */
  function notifyParty(tx, party, type, text) {
    if (party.subjectKind === 'player') notify({ kind: 'player', id: party.subjectId }, type, text, tx.id);
    else for (const u of (db.verAdmins ?? []).filter((a) => a.orgId === party.subjectId && a.status === 'active')) notify({ kind: 'org_user', id: u.userId }, type, text, tx.id);
  }

  // ============================================================ AGENT lane

  orgRouter.get('/agent/transactions', (req, res) => {
    if (!agent.resolveMembership(req, res)) return;
    if (!agent.requireCap(req, res, 'transactions.read')) return;
    const status = req.query.status ? String(req.query.status) : null;
    // Personal to the agent: a colleague's transactions are not listed and
    // their count is not disclosed either.
    const mine = db.agentTransactions.filter((t) => t && t.agencyOrgId === req.org.id && t.agentUserId === req.orgUser.id && (!status || t.status === status));
    const viewer = agentViewer(req);
    res.json({
      items: mine.map((t) => projectTransaction(t, viewer)),
      statuses: TRANSACTION_STATUSES, types: TRANSACTION_TYPES, partyRoles: PARTY_ROLES,
      documentTypes: DOCUMENT_TYPES, visibilities: DOCUMENT_VISIBILITY, roomRoles: ROOM_ROLES,
      holdReasonCodes: HOLD_REASON_CODES, cancelReasonCodes: CANCEL_REASON_CODES, closeReasonCodes: CLOSE_REASON_CODES,
      transitions: ALL_TRANSITIONS, pendingReasons: PENDING_REASONS,
      counts: {
        live: mine.filter((t) => LIVE_STATUSES.includes(t.status)).length,
        blocked: mine.filter((t) => t.status === 'COMPLIANCE_BLOCKED').length,
        pending: mine.filter((t) => t.status === 'COMPLIANCE_PENDING').length,
        ready: mine.filter((t) => t.status === 'READY').length,
        awaitingConfirmation: mine.filter((t) => LIVE_STATUSES.includes(t.status) && !partiesConfirmed(t)).length,
      },
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
    const type = String(b.type ?? '');
    if (!TRANSACTION_TYPES.includes(type)) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'type', allowed: TRANSACTION_TYPES }, 'create');
    const jurisdictions = Array.isArray(b.jurisdictions) ? [...new Set(b.jurisdictions.map((j) => String(j).toUpperCase()))] : [];
    if (!jurisdictions.length || jurisdictions.some((j) => !/^[A-Z]{3}$/.test(j))) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'jurisdictions', message: 'jurisdictions must be a non-empty list of three-letter member-association codes (INT for FIFA level).' }, 'create');
    const fp = payloadFingerprint({ type, jurisdictions, parties: Array.isArray(b.parties) ? b.parties : [] });
    if (key) {
      const hit = db.agentTransactions.find((t) => t && t.agencyOrgId === req.org.id && t.agentUserId === req.orgUser.id && t.keys?.create?.key === key);
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
    for (const raw of Array.isArray(b.parties) ? b.parties.slice(0, TRANSACTION_LIMITS.parties) : []) {
      const party = resolveParty(req, res, raw, { type }); if (!party) return;
      if (parties.some((x) => x.partyRole === party.partyRole)) return sendTransactionError(res, { error: 'TRANSACTION_PARTY_EXISTS', partyRole: party.partyRole, message: `A ${party.partyRole} party is already named.` }, 'create');
      parties.push(party);
    }
    const tx = {
      id: nextId('atx'), agencyOrgId: req.org.id, agentUserId: req.orgUser.id, type, jurisdictions,
      status: 'DRAFT', parties, contextId: null, compliance: null, reEvaluationPending: false,
      notes: [], linkedThreads: [], links: { trialId: null, opportunityId: null }, terms: { versions: [] },
      holdReasonCode: null, holdReason: null, heldAt: null, cancelReasonCode: null, closeReasonCode: null,
      initiatedBy: byAgent(req), initiatedAt: now(), createdAt: now(), updatedAt: now(),
      keys: key ? { create: { key, fp } } : {}, rev: 1, revAt: now(), revBy: null, history: [],
    };
    for (const p of parties) hist(p, 'transaction_party_added', byAgent(req), { partyRole: p.partyRole, subjectKind: p.subjectKind });
    hist(tx, 'transaction_created', byAgent(req), { count: parties.length });
    const ctx = compliance.openContext({ agencyOrgId: req.org.id, agentUserId: req.orgUser.id, type, jurisdictions, transactionId: tx.id, by: byAgent(req) });
    tx.contextId = ctx.id;
    db.agentTransactions.push(tx);
    recheckCompliance(tx, byAgent(req));
    broadcast('agent_transaction_created', { orgId: req.org.id, txId: tx.id });
    for (const p of parties) notifyParty(tx, p, 'agent_transaction_action', `A transaction workspace has been opened naming you as the ${p.partyRole.replace(/_/g, ' ')}. Confirm your participation to let it proceed. Confirming does not agree to any terms.`);
    persistNow();
    res.status(201).json({ transaction: projectTransaction(tx, agentViewer(req)) });
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
    if (key && tx.keys?.[`party:${key}`]) { if (tx.keys[`party:${key}`].fp === fp) return res.json({ transaction: projectTransaction(tx, agentViewer(req)), idempotent: true }); return sendTransactionError(res, { error: 'TRANSACTION_IDEMPOTENCY_CONFLICT' }, 'parties'); }
    if (tx.parties.some((x) => !x.removed && x.partyRole === party.partyRole)) return sendTransactionError(res, { error: 'TRANSACTION_PARTY_EXISTS', partyRole: party.partyRole }, 'parties');
    if (tx.parties.length >= TRANSACTION_LIMITS.parties * 3) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'parties', message: 'This transaction already holds the maximum number of party records.' }, 'parties');
    if (!guardRev(req, res, tx, { errorCode: 'TRANSACTION_VERSION_CONFLICT', current: { status: tx.status } })) return;
    hist(party, 'transaction_party_added', byAgent(req), { partyRole: party.partyRole, subjectKind: party.subjectKind });
    tx.parties.push(party);
    if (key) { tx.keys ??= {}; tx.keys[`party:${key}`] = { key, fp }; }
    hist(tx, 'transaction_party_added', byAgent(req), { partyRole: party.partyRole, subjectKind: party.subjectKind });
    // A party change invalidates every prior clearance (§10): the compliance
    // snapshot is recomputed here and now, not carried over.
    partyChanged(tx, byAgent(req));
    broadcast('agent_transaction_party_changed', { orgId: tx.agencyOrgId, txId: tx.id, partyRole: party.partyRole });
    notifyParty(tx, party, 'agent_transaction_action', `A transaction workspace now names you as the ${party.partyRole.replace(/_/g, ' ')}. Confirm your participation to let it proceed. Confirming does not agree to any terms.`);
    bumpTxRev(tx, byAgent(req)); persistNow();
    res.status(201).json({ transaction: projectTransaction(tx, agentViewer(req)) });
  });

  /**
   * Remove a party. History is never overwritten (§9): the row stays with its
   * `removedAt`, every representation naming that role is withdrawn, and the
   * transaction drops back out of any compliance claim it had.
   */
  orgRouter.post('/agent/transactions/:id/parties/:pid/remove', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    if (!writableOr(res, tx, 'parties')) return;
    const party = tx.parties.find((p) => p && p.id === req.params.pid);
    if (!party) return sendTransactionError(res, { error: 'TRANSACTION_PARTY_NOT_FOUND' }, 'parties');
    if (party.removed) return res.json({ transaction: projectTransaction(tx, agentViewer(req)), idempotent: true });
    if (!guardRev(req, res, tx, { errorCode: 'TRANSACTION_VERSION_CONFLICT', current: { status: tx.status } })) return;
    party.removed = true; party.removedAt = now();
    hist(party, 'transaction_party_removed', byAgent(req), { partyRole: party.partyRole });
    hist(tx, 'transaction_party_removed', byAgent(req), { partyRole: party.partyRole, subjectKind: party.subjectKind });
    for (const r of repsOf(tx.id)) {
      if (r.partyRole !== party.partyRole || r.status === 'withdrawn') continue;
      r.status = 'withdrawn'; r.withdrawnAt = now(); r.withdrawnReason = 'party_removed';
      hist(r, 'transaction_representation_withdrawn', byAgent(req), { partyRole: r.partyRole, status: 'withdrawn' });
      bumpRev(r, { by: req.orgUser, at: now() });
    }
    partyChanged(tx, byAgent(req));
    broadcast('agent_transaction_party_changed', { orgId: tx.agencyOrgId, txId: tx.id, partyRole: party.partyRole });
    bumpTxRev(tx, byAgent(req)); persistNow();
    res.json({ transaction: projectTransaction(tx, agentViewer(req)) });
  });

  /**
   * What a party change does, in one place so it cannot be done differently in
   * two routes: a confirmed transaction that loses its confirmation set falls
   * back out of READY/ACTIVE, and compliance is re-evaluated immediately.
   */
  function partyChanged(tx, by) {
    if (!partiesConfirmed(tx) && ['READY', 'ACTIVE', 'COMPLIANCE_PENDING', 'COMPLIANCE_BLOCKED'].includes(tx.status)) {
      const from = tx.status;
      tx.status = 'PARTIES_CONFIRMED';
      hist(tx, 'transaction_status_changed', by, { from, to: tx.status, pendingReason: 'PARTIES_NOT_CONFIRMED' });
      broadcast('agent_transaction_status_changed', { orgId: tx.agencyOrgId, txId: tx.id, status: tx.status });
    }
    if (tx.status === 'DRAFT' && partiesConfirmed(tx)) {
      hist(tx, 'transaction_status_changed', by, { from: 'DRAFT', to: 'PARTIES_CONFIRMED' });
      tx.status = 'PARTIES_CONFIRMED';
      broadcast('agent_transaction_status_changed', { orgId: tx.agencyOrgId, txId: tx.id, status: tx.status });
    }
    recheckCompliance(tx, by);
  }

  /**
   * THE regulated mutation of P5.6D: bind a representation to this transaction.
   *
   * "Active for this player" is not authority for this transaction (§24): the
   * agreement is re-read now, its scope must cover this transaction's type and
   * every one of its jurisdictions, the facets must be verified now, and the
   * conflict engine must answer now with this binding included. A refusal at
   * any step records nothing.
   */
  orgRouter.post('/agent/transactions/:id/representations', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    if (!writableOr(res, tx, 'representations')) return;
    const b = req.body ?? {};
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    const partyRole = String(b.partyRole ?? '');
    const party = tx.parties.find((p) => !p.removed && p.partyRole === partyRole);
    if (!party) return sendTransactionError(res, { error: 'TRANSACTION_PARTY_NOT_FOUND' }, 'representations');
    const fp = payloadFingerprint({ partyRole, agreementId: b.agreementId ?? null });
    if (key) {
      const hit = repsOf(tx.id).find((r) => r.keys?.attach?.key === key);
      if (hit) { if (hit.keys.attach.fp === fp) return res.json({ transaction: projectTransaction(tx, agentViewer(req)), idempotent: true }); return sendTransactionError(res, { error: 'TRANSACTION_IDEMPOTENCY_CONFLICT' }, 'representations'); }
    }
    if (limitedOr429(res, 'transaction_write', req.orgUser.id)) return;
    if (repsOf(tx.id).some((r) => r.partyRole === partyRole && r.status !== 'withdrawn' && r.agentUserId === req.orgUser.id)) {
      return sendTransactionError(res, { error: 'TRANSACTION_PARTY_EXISTS', partyRole, message: 'You already represent this party in this transaction.' }, 'representations');
    }
    // Step 8: safeguarding before scope, so a blocked party is never
    // distinguishable from an unknown one by comparing refusals.
    let agreement = null; let declaredOnly = false; let scope = []; let jurisdictions = [];
    if (party.subjectKind === 'player') {
      const pl = findPlayer(party.subjectId);
      if (!pl || !isAdult(pl) || !orgCanSee(req.org, pl) || isBlocked(pl.id, req.org.id)) return sendTransactionError(res, { error: 'TRANSACTION_PARTY_NOT_FOUND' }, 'representations');
      agreement = (db.representationAgreements ?? []).find((a) => a && a.id === String(b.agreementId ?? '') && a.agentUserId === req.orgUser.id && a.agencyOrgId === req.org.id && a.clientId === party.subjectId) ?? null;
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
    // Steps 11–14: conflict, consent, minor gate and review, with the proposed
    // binding included. Nothing is recorded if the answer is not permissive.
    const ctx = compliance.contextById(tx.contextId);
    compliance.project(ctx, { parties: tx.parties, representations: repsOf(tx.id).filter((r) => r.status !== 'withdrawn') });
    const proposed = { agentUserId: req.orgUser.id, partyRole, agreementId: agreement?.id ?? null, declaredOnly, status: declaredOnly ? 'declared' : 'verified', firstActAt: now() };
    const result = compliance.evaluate(ctx, byAgent(req), { proposed });
    if (result.outcome === 'PROHIBITED_CONFLICT') {
      applyComplianceSnapshot(tx, { state: complianceStateFrom({ outcome: result.outcome, reasons: result.reasons, representationCount: repsOf(tx.id).filter((r) => r.status !== 'withdrawn').length, partiesConfirmed: partiesConfirmed(tx) }), result, ctx, by: byAgent(req), partyRevision: currentPartyRevision(tx) });
      bumpTxRev(tx, byAgent(req)); persistNow();
      return sendTransactionError(res, { error: 'REPRESENTATION_CONFLICT', reasons: result.reasons.filter((r) => ['PROHIBITED_COMBINATION', 'COMBINATION_NOT_PERMITTED', 'CONNECTED_AGENT_ATTRIBUTION'].includes(r.code)), policyVersions: result.policyVersions, outcome: result.outcome, message: 'An encoded ACTIVE rule prohibits this combination of parties. Nothing was recorded.' }, 'representations');
    }
    if (result.outcome === 'PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED') {
      applyComplianceSnapshot(tx, { state: complianceStateFrom({ outcome: result.outcome, reasons: result.reasons, consentsOutstanding: result.consentsOutstanding, representationCount: repsOf(tx.id).filter((r) => r.status !== 'withdrawn').length, partiesConfirmed: partiesConfirmed(tx) }), result, ctx, by: byAgent(req), partyRevision: currentPartyRevision(tx) });
      bumpTxRev(tx, byAgent(req)); persistNow();
      return sendTransactionError(res, { error: 'CONSENT_REQUIRED', consentsOutstanding: result.consentsOutstanding, reasons: result.reasons.filter((r) => r.code === 'CONSENT_REQUIRED'), policyVersions: result.policyVersions, outcome: result.outcome, contextId: ctx.id, message: 'Prior, party-specific written consent is outstanding. Request it; nothing was recorded.' }, 'representations');
    }
    if (!guardRev(req, res, tx, { errorCode: 'TRANSACTION_VERSION_CONFLICT', current: { status: tx.status } })) return;
    const needsReview = result.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED' || result.outcome === 'INSUFFICIENT_DATA';
    if (needsReview && !declaredOnly) {
      // Nothing is recorded: the binding the caller asked for does not exist,
      // and a review item exists instead.
      const review = compliance.createReview({ kind: 'conflict_evaluation', agencyOrgId: tx.agencyOrgId, agentUserId: req.orgUser.id, subject: { contextId: ctx.id, transactionId: tx.id, partyRole }, reasons: result.reasons.filter((r) => r.code !== 'FACET_VERIFIED'), policyVersions: result.policyVersions, snapshot: { ...result, proposed: { partyRole, agentUserId: req.orgUser.id } }, requestedBy: byAgent(req) });
      applyComplianceSnapshot(tx, { state: complianceStateFrom({ outcome: result.outcome, reasons: result.reasons, representationCount: repsOf(tx.id).filter((r) => r.status !== 'withdrawn').length, partiesConfirmed: partiesConfirmed(tx) }), result, ctx, by: byAgent(req), partyRevision: currentPartyRevision(tx) });
      bumpTxRev(tx, byAgent(req)); persistNow();
      return sendTransactionError(res, { error: 'REGULATORY_REVIEW_REQUIRED', reasons: review.reasons, policyVersions: result.policyVersions, outcome: result.outcome, contextId: ctx.id, message: 'The deciding rule\'s operative status is uncertain or not encoded. An attributed review item was created; nothing proceeds until it is resolved under a named policy version.' }, 'representations');
    }
    const rep = {
      id: nextId('txr'), transactionId: tx.id, agencyOrgId: tx.agencyOrgId, agentUserId: req.orgUser.id, partyRole,
      agreementId: agreement?.id ?? null, declaredOnly, declaredEvidenceId: null,
      scope, jurisdictions, status: declaredOnly ? 'pending_review' : 'verified',
      reviewId: null, createdAt: now(), verifiedAt: declaredOnly ? null : now(), firstActAt: declaredOnly ? null : now(), withdrawnAt: null,
      keys: key ? { attach: { key, fp } } : {}, rev: 1, revAt: now(), revBy: null, history: [],
    };
    if (declaredOnly) {
      const review = compliance.createReview({ kind: 'representation_declared', agencyOrgId: tx.agencyOrgId, agentUserId: req.orgUser.id, subject: { contextId: ctx.id, transactionId: tx.id, representationId: rep.id, partyRole }, reasons: result.reasons.filter((r) => r.code !== 'FACET_VERIFIED'), policyVersions: result.policyVersions, snapshot: { ...result, proposed: { partyRole, agentUserId: req.orgUser.id } }, requestedBy: byAgent(req) });
      rep.reviewId = review.id;
    }
    hist(rep, 'transaction_representation_attached', byAgent(req), { partyRole, status: rep.status, policyVersions: result.policyVersions });
    db.transactionRepresentations.push(rep);
    hist(tx, 'transaction_representation_attached', byAgent(req), { partyRole, status: rep.status });
    recheckCompliance(tx, byAgent(req));
    bumpTxRev(tx, byAgent(req)); persistNow();
    // A declared-only binding is RECORDED and NOT EFFECTIVE. It answers 422 with
    // the review it created rather than 201, for the same reason P5.6C does: a
    // 201 reads as "this is now in force", and it is not — an attributed
    // reviewer has to confirm it first (DR-18).
    if (declaredOnly) {
      return sendTransactionError(res, { error: 'REGULATORY_REVIEW_REQUIRED', reasons: result.reasons.filter((r) => r.code !== 'FACET_VERIFIED'), policyVersions: result.policyVersions, outcome: result.outcome, contextId: ctx.id, partyRole, message: 'Representation of an entity with no ScoutBox agreement is recorded as declared and needs attributed review. It is not effective until a named reviewer confirms it.' }, 'representations');
    }
    res.status(201).json({ transaction: projectTransaction(tx, agentViewer(req)), representation: { id: rep.id, partyRole, status: rep.status } });
  });

  orgRouter.post('/agent/transactions/:id/representations/:rid/withdraw', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    if (!writableOr(res, tx, 'representations')) return;
    const rep = repsOf(tx.id).find((r) => r.id === req.params.rid && r.agentUserId === req.orgUser.id);
    if (!rep) return notFound(res, 'representations');
    if (rep.status === 'withdrawn') return res.json({ transaction: projectTransaction(tx, agentViewer(req)), idempotent: true });
    if (!guardRev(req, res, tx, { errorCode: 'TRANSACTION_VERSION_CONFLICT', current: { status: tx.status } })) return;
    rep.status = 'withdrawn'; rep.withdrawnAt = now(); rep.withdrawnReason = 'agent_withdrew';
    hist(rep, 'transaction_representation_withdrawn', byAgent(req), { partyRole: rep.partyRole });
    hist(tx, 'transaction_representation_withdrawn', byAgent(req), { partyRole: rep.partyRole });
    bumpTxRev(rep, byAgent(req));
    recheckCompliance(tx, byAgent(req));
    bumpTxRev(tx, byAgent(req)); persistNow();
    res.json({ transaction: projectTransaction(tx, agentViewer(req)) });
  });

  orgRouter.post('/agent/transactions/:id/evaluate', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    if (!writableOr(res, tx, 'evaluate')) return;
    if (limitedOr429(res, 'transaction_write', req.orgUser.id)) return;
    recheckCompliance(tx, byAgent(req));
    bumpTxRev(tx, byAgent(req)); persistNow();
    res.json({ transaction: projectTransaction(tx, agentViewer(req)) });
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
    const to = String(req.body?.to ?? '');
    if (!TRANSACTION_STATUSES.includes(to)) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'to', allowed: TRANSACTION_STATUSES }, 'status');
    if (tx.status === 'ARCHIVED') return sendTransactionError(res, { error: 'TRANSACTION_ARCHIVED', status: tx.status, message: 'An archived transaction is read-only.' }, 'status');
    const guard = safeguardingProblem(tx);
    // ARCHIVED is the one transition a safeguarding stop must not prevent:
    // shelving a record the workspace can no longer act on is the safe move.
    if (guard && to !== 'ARCHIVED') return sendTransactionError(res, { error: 'TRANSACTION_PARTY_UNAVAILABLE', message: 'A party to this transaction is no longer available to your organisation. It can be archived; it cannot be progressed.' }, 'status');
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    const reasonCode = str(req.body?.reasonCode, 60);
    const reason = str(req.body?.reason, TRANSACTION_LIMITS.reason);
    const fp = payloadFingerprint({ to, reasonCode, reason });
    // The idempotency check comes BEFORE the transition check: a replay of a
    // transition that already happened must answer "already done", not "you
    // cannot do that from here" — which is what the caller would see, since the
    // transition it is replaying is exactly what moved the transaction.
    if (key && tx.keys?.[`status:${key}`]) { if (tx.keys[`status:${key}`].fp === fp) return res.json({ transaction: projectTransaction(tx, agentViewer(req)), idempotent: true }); return sendTransactionError(res, { error: 'TRANSACTION_IDEMPOTENCY_CONFLICT' }, 'status'); }
    if (!actorTransitionAllowed(tx.status, to)) return sendTransactionError(res, { error: 'TRANSACTION_TRANSITION_NOT_ALLOWED', from: tx.status, to, allowed: ACTOR_TRANSITIONS[tx.status] ?? [], message: 'That is not a transition this transaction can make from its current state.' }, 'status');
    if (limitedOr429(res, 'transaction_status_write', req.orgUser.id)) return;
    if (to === 'PARTIES_CONFIRMED') {
      if (!partiesConfirmed(tx)) return sendTransactionError(res, { error: 'TRANSACTION_PARTIES_NOT_CONFIRMED', awaiting: partiesAwaitingConfirmation(tx), message: 'Every required party must confirm its own participation first. Naming a party is not confirming it.' }, 'status');
    }
    if (to === 'ON_HOLD' && !HOLD_REASON_CODES.includes(reasonCode)) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'reasonCode', allowed: HOLD_REASON_CODES }, 'status');
    if (to === 'CANCELLED' && !CANCEL_REASON_CODES.includes(reasonCode)) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'reasonCode', allowed: CANCEL_REASON_CODES }, 'status');
    if (to === 'CLOSED' && !CLOSE_REASON_CODES.includes(reasonCode)) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'reasonCode', allowed: CLOSE_REASON_CODES }, 'status');
    if (to === 'ACTIVE') {
      // A stale snapshot authorises nothing (§27). Refusing FIRST — before the
      // re-check — is deliberate: it means the caller cannot enter the live
      // workflow on facts they have not seen, because they must re-evaluate and
      // read the new answer before asking again. The re-check below is the
      // second guard, not the only one.
      const stale0 = stalenessOf(tx);
      if (stale0) {
        tx.reEvaluationPending = true;
        hist(tx, 'transaction_compliance_stale', byAgent(req), { staleness: stale0 });
        tx.updatedAt = now(); bumpTxRev(tx, byAgent(req)); persistNow();
        return sendTransactionError(res, { error: 'TRANSACTION_COMPLIANCE_STALE', staleness: stale0, message: 'The recorded compliance evaluation no longer matches the current facts. Re-evaluate and read the new answer before progressing.' }, 'status');
      }
      // Leaving a hold never resumes on trust (§19): compliance is re-checked
      // here, in this request, and the answer decides.
      const { safeguarding, state } = recheckCompliance(tx, byAgent(req));
      if (safeguarding) { persistNow(); return notFound(res, 'status'); }
      if (state?.blocked) { bumpTxRev(tx, byAgent(req)); persistNow(); return sendTransactionError(res, { error: 'TRANSACTION_COMPLIANCE_BLOCKED', outcome: state.outcome, reasons: state.reasonCodes.map((code) => ({ code })), message: 'An encoded ACTIVE rule prohibits this combination. A reviewer cannot approve past it; only changed facts or a new policy version can.' }, 'status'); }
      if (!state?.clear) { bumpTxRev(tx, byAgent(req)); persistNow(); return sendTransactionError(res, { error: 'TRANSACTION_COMPLIANCE_PENDING', pendingReason: state?.pendingReason ?? null, outcome: state?.outcome ?? null, reasons: (state?.reasonCodes ?? []).map((code) => ({ code })), message: 'This transaction cannot progress while compliance is outstanding.' }, 'status'); }
      // Re-check the transition: the re-evaluation above may have moved the
      // status, and the caller's transition must still be legal from where the
      // transaction now is.
      if (!actorTransitionAllowed(tx.status, to)) { bumpTxRev(tx, byAgent(req)); persistNow(); return sendTransactionError(res, { error: 'TRANSACTION_TRANSITION_NOT_ALLOWED', from: tx.status, to, allowed: ACTOR_TRANSITIONS[tx.status] ?? [] }, 'status'); }
    }
    if (!guardRev(req, res, tx, { errorCode: 'TRANSACTION_VERSION_CONFLICT', current: { status: tx.status } })) return;
    const from = tx.status;
    tx.status = to;
    if (key) { tx.keys ??= {}; tx.keys[`status:${key}`] = { key, fp }; }
    if (to === 'ON_HOLD') { tx.holdReasonCode = reasonCode; tx.holdReason = reason || null; tx.heldAt = now(); }
    if (to === 'ACTIVE') { tx.holdReasonCode = null; tx.holdReason = null; tx.heldAt = null; }
    if (to === 'CANCELLED') { tx.cancelReasonCode = reasonCode; tx.cancelledAt = now(); }
    if (to === 'CLOSED') { tx.closeReasonCode = reasonCode; tx.closedAt = now(); }
    if (to === 'ARCHIVED') tx.archivedAt = now();
    const action = to === 'ON_HOLD' ? 'transaction_held' : to === 'CANCELLED' ? 'transaction_cancelled' : to === 'CLOSED' ? 'transaction_closed' : to === 'ARCHIVED' ? 'transaction_archived' : 'transaction_status_changed';
    hist(tx, action, byAgent(req), { from, to, ...(reasonCode ? { holdReasonCode: reasonCode } : {}) });
    if (['CANCELLED', 'CLOSED'].includes(to)) {
      const ctx = compliance.contextById(tx.contextId);
      if (ctx) compliance.closeContext(ctx, byAgent(req));
    }
    // Literal event names, one call site each: the M18.2 registry audit reads
    // broadcast call sites textually, so a name that only ever appears inside a
    // ternary is a registered event the audit cannot see being emitted.
    const payload = { orgId: tx.agencyOrgId, txId: tx.id, status: tx.status };
    if (to === 'ON_HOLD') broadcast('agent_transaction_held', payload);
    else if (to === 'CANCELLED') broadcast('agent_transaction_cancelled', payload);
    else if (to === 'CLOSED') broadcast('agent_transaction_closed', payload);
    else broadcast('agent_transaction_status_changed', payload);
    for (const p of tx.parties.filter((x) => !x.removed)) {
      notifyParty(tx, p, 'agent_transaction', `A transaction you are party to is now "${to.replace(/_/g, ' ').toLowerCase()}". Nothing has been agreed or signed.`);
    }
    tx.updatedAt = now(); bumpTxRev(tx, byAgent(req)); persistNow();
    res.json({ transaction: projectTransaction(tx, agentViewer(req)) });
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
    compliance.project(ctx, { parties: tx.parties, representations: repsOf(tx.id).filter((r) => r.status !== 'withdrawn') });
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
    const summary = str(req.body?.summary, TRANSACTION_LIMITS.note);
    const recordedFor = String(req.body?.recordedFor ?? '');
    const visibility = String(req.body?.visibility ?? '');
    if (!summary) return sendTransactionError(res, { error: 'TERMS_INPUT_INVALID', field: 'summary', message: 'A terms version needs a written summary of what the parties recorded.' }, 'terms');
    if (!PARTY_ROLES.includes(recordedFor)) return sendTransactionError(res, { error: 'TERMS_INPUT_INVALID', field: 'recordedFor', allowed: PARTY_ROLES }, 'terms');
    const roles = roomRolesFor(tx, agentViewer(req));
    if (!uploadableVisibilities(roles).includes(visibility)) return sendTransactionError(res, { error: 'DOCUMENT_VISIBILITY_NOT_PERMITTED', visibility, allowed: uploadableVisibilities(roles) }, 'terms');
    if ((tx.terms?.versions ?? []).length >= TRANSACTION_LIMITS.termsVersions) return sendTransactionError(res, { error: 'TERMS_INPUT_INVALID', field: 'summary', message: 'This transaction already holds the maximum number of recorded terms versions.' }, 'terms');
    if (!guardRev(req, res, tx, { errorCode: 'TRANSACTION_VERSION_CONFLICT', current: { status: tx.status } })) return;
    tx.terms ??= { versions: [] };
    const v = { id: nextId('txt'), at: now(), by: byAgent(req), recordedFor, visibility, summary, version: tx.terms.versions.length + 1 };
    tx.terms.versions.push(v);
    hist(tx, 'transaction_terms_recorded', byAgent(req), { partyRole: recordedFor, visibility, version: v.version });
    tx.updatedAt = now(); bumpTxRev(tx, byAgent(req)); persistNow();
    res.status(201).json({ transaction: projectTransaction(tx, agentViewer(req)) });
  });

  /** Reference an Opportunity this transaction came from (§49). By reference; the opportunity is not mutated. */
  orgRouter.post('/agent/transactions/:id/links', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    if (!writableOr(res, tx, 'links')) return;
    const opportunityId = str(req.body?.opportunityId, 60);
    if (!opportunityId) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'opportunityId' }, 'links');
    const opp = (db.opportunities ?? []).find((o) => o && o.id === opportunityId);
    // A link to an opportunity the agent cannot see would disclose that it
    // exists, so an unknown and an invisible opportunity answer alike.
    const engaging = tx.parties.find((p) => !p.removed && p.partyRole === 'engaging_entity');
    if (!opp || !engaging || opp.orgId !== engaging.subjectId) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'opportunityId', message: 'No opportunity of the engaging club matches that reference.' }, 'links');
    if (!guardRev(req, res, tx, { errorCode: 'TRANSACTION_VERSION_CONFLICT', current: { status: tx.status } })) return;
    tx.links ??= { trialId: null, opportunityId: null };
    tx.links.opportunityId = opp.id;
    hist(tx, 'transaction_status_changed', byAgent(req), { from: tx.status, to: tx.status });
    tx.updatedAt = now(); bumpTxRev(tx, byAgent(req)); persistNow();
    res.json({ transaction: projectTransaction(tx, agentViewer(req)) });
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
    const documentType = String(b.documentType ?? '');
    const visibility = String(b.visibility ?? '');
    const label = str(b.label, TRANSACTION_LIMITS.label);
    if (!DOCUMENT_TYPES.includes(documentType)) return sendTransactionError(res, { error: 'DOCUMENT_INPUT_INVALID', field: 'documentType', allowed: DOCUMENT_TYPES }, 'documents');
    const allowed = uploadableVisibilities(roles, partyRole);
    if (!allowed.includes(visibility)) return sendTransactionError(res, { error: 'DOCUMENT_VISIBILITY_NOT_PERMITTED', visibility, allowed, message: 'You cannot file a document into a lane you do not sit in, and nobody may file into the Trust & Safety lane.' }, 'documents');
    if (!label) return sendTransactionError(res, { error: 'DOCUMENT_INPUT_INVALID', field: 'label', message: 'A document needs a label the other parties can read.' }, 'documents');
    let evidenceRef = null;
    if (b.evidenceRef != null) {
      const kind = String(b.evidenceRef?.kind ?? '');
      const id = str(b.evidenceRef?.id, 80);
      if (kind !== 'verification_evidence' || !id) return sendTransactionError(res, { error: 'DOCUMENT_INPUT_INVALID', field: 'evidenceRef', allowed: ['verification_evidence'], message: 'A document reference is { kind: "verification_evidence", id } naming a record in the canonical evidence vault.' }, 'documents');
      const ev = (db.verEvidence ?? []).find((e) => e && e.id === id);
      // The uploader must own the evidence: a reference is not a way to reach
      // someone else's file, and an unknown id and a foreign id answer alike.
      const mine = ev && ((owner.kind === 'club' && ev.orgId === owner.id) || (owner.kind === 'player' && ev.playerId === owner.id) || (owner.kind === 'agent' && ev.orgId === tx.agencyOrgId));
      if (!ev || !mine) return sendTransactionError(res, { error: 'DOCUMENT_INPUT_INVALID', field: 'evidenceRef', message: 'No evidence record of yours matches that reference.' }, 'documents');
      evidenceRef = { kind: 'verification_evidence', id: ev.id };
    }
    const expiresAt = b.expiresAt == null ? null : Number(b.expiresAt);
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now())) return sendTransactionError(res, { error: 'DOCUMENT_INPUT_INVALID', field: 'expiresAt', message: 'An expiry must be a future timestamp.' }, 'documents');
    const fp = payloadFingerprint({ documentType, visibility, label, evidenceRef });
    if (key) {
      const hit = db.transactionDocuments.find((d) => d && d.transactionId === tx.id && d.keys?.add?.key === key);
      if (hit) { if (hit.keys.add.fp === fp) return res.json({ document: documentView(hit, roles, partyRole), idempotent: true }); return sendTransactionError(res, { error: 'TRANSACTION_IDEMPOTENCY_CONFLICT' }, 'documents'); }
    }
    if (docsOf(tx.id).length >= TRANSACTION_LIMITS.documents) return sendTransactionError(res, { error: 'DOCUMENT_INPUT_INVALID', field: 'documentType', message: 'This transaction already holds the maximum number of documents.' }, 'documents');
    const d = {
      id: nextId('txd'), transactionId: tx.id, documentType, visibility, label, version: 1,
      owner, ownerPartyRole: partyRole, uploadedBy: by, createdAt: now(),
      expiresAt, signedAt: null, evidenceRef, supersedes: null, supersededBy: null, removedAt: null,
      keys: key ? { add: { key, fp } } : {}, rev: 1, revAt: now(), revBy: null, history: [],
    };
    hist(d, 'transaction_document_added', by, { documentType, visibility, version: 1 });
    db.transactionDocuments.push(d);
    hist(tx, 'transaction_document_added', by, { documentType, visibility });
    broadcast('agent_transaction_document_added', { orgId: tx.agencyOrgId, txId: tx.id, docId: d.id });
    // Only the parties the CLASS admits hear about it: a notification is a
    // disclosure, and an AGENT_PRIVATE document discloses nothing to anyone.
    if (visibility !== 'AGENT_PRIVATE') {
      for (const p of tx.parties.filter((x) => !x.removed)) {
        const otherRoles = p.subjectKind === 'player' ? ['party_individual'] : ['party_club_signatory'];
        if (!canSeeVisibility(visibility, otherRoles, p.partyRole)) continue;
        if (p.subjectKind === 'player' && owner.kind === 'player' && p.subjectId === owner.id) continue;
        if (p.subjectKind === 'club' && owner.kind === 'club' && p.subjectId === owner.id) continue;
        notifyParty(tx, p, 'agent_transaction', `A document has been shared in a transaction you are party to: ${label}.`);
      }
      if (owner.kind !== 'agent') notify({ kind: 'org_user', id: tx.agentUserId }, 'agent_transaction', `A party shared a document in a transaction: ${label}.`, tx.id);
    }
    tx.updatedAt = now(); persistNow();
    res.status(201).json({ document: documentView(d, roles, partyRole) });
  }

  /** Read a document's reference. Reauthorized every time (§80): a reference is never a standing permission. */
  function readDocumentReference(req, res, tx, { roles, partyRole }) {
    const d = db.transactionDocuments.find((x) => x && x.id === req.params.docId && x.transactionId === tx.id && !x.removedAt);
    if (!d || !canSeeVisibility(d.visibility, roles, partyRole)) return sendTransactionError(res, { error: 'DOCUMENT_NOT_FOUND', message: 'No document with that reference is available to you.' }, 'documents');
    if (typeof d.expiresAt === 'number' && d.expiresAt <= now()) return sendTransactionError(res, { error: 'DOCUMENT_NOT_FOUND', message: 'No document with that reference is available to you.' }, 'documents');
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
  /** A new version supersedes the old one; the old row is kept, never edited (§32 version). */
  orgRouter.post('/agent/transactions/:id/documents/:docId/supersede', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true }); if (!tx) return;
    if (!writableOr(res, tx, 'documents')) return;
    const old = db.transactionDocuments.find((x) => x && x.id === req.params.docId && x.transactionId === tx.id && !x.removedAt);
    const roles = roomRolesFor(tx, agentViewer(req));
    if (!old || old.owner?.kind !== 'agent' || !canSeeVisibility(old.visibility, roles)) return sendTransactionError(res, { error: 'DOCUMENT_NOT_FOUND' }, 'documents');
    if (old.supersededBy) return sendTransactionError(res, { error: 'DOCUMENT_SUPERSEDED', message: 'That version has already been superseded.' }, 'documents');
    const label = str(req.body?.label, TRANSACTION_LIMITS.label) || old.label;
    if (!guardRev(req, res, old, { errorCode: 'DOCUMENT_VERSION_CONFLICT', current: { version: old.version } })) return;
    const d = { ...old, id: nextId('txd'), version: old.version + 1, label, supersedes: old.id, supersededBy: null, createdAt: now(), uploadedBy: byAgent(req), keys: {}, rev: 1, revAt: now(), revBy: null, history: [] };
    hist(d, 'transaction_document_added', byAgent(req), { documentType: d.documentType, visibility: d.visibility, version: d.version });
    old.supersededBy = d.id;
    hist(old, 'transaction_document_superseded', byAgent(req), { version: old.version });
    bumpTxRev(old, byAgent(req));
    db.transactionDocuments.push(d);
    hist(tx, 'transaction_document_superseded', byAgent(req), { documentType: d.documentType, version: d.version });
    tx.updatedAt = now(); persistNow();
    res.status(201).json({ document: documentView(d, roles) });
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
    const text = str(req.body?.text, TRANSACTION_LIMITS.note);
    const visibility = String(req.body?.visibility ?? '');
    if (!text) return sendTransactionError(res, { error: 'NOTE_INPUT_INVALID', field: 'text' }, 'notes');
    const allowed = uploadableVisibilities(roles, partyRole).filter((v) => NOTE_VISIBILITY.includes(v));
    if (!allowed.includes(visibility)) return sendTransactionError(res, { error: 'DOCUMENT_VISIBILITY_NOT_PERMITTED', visibility, allowed }, 'notes');
    if ((tx.notes ?? []).length >= TRANSACTION_LIMITS.notes) return sendTransactionError(res, { error: 'NOTE_INPUT_INVALID', field: 'text', message: 'This transaction already holds the maximum number of notes.' }, 'notes');
    if (!guardRev(req, res, tx, { errorCode: 'TRANSACTION_VERSION_CONFLICT', current: { status: tx.status } })) return;
    tx.notes ??= [];
    const n = { id: nextId('txn'), visibility, text, by, at: now(), removedAt: null };
    tx.notes.push(n);
    hist(tx, 'transaction_note_added', by, { visibility });
    tx.updatedAt = now(); bumpTxRev(tx, by); persistNow();
    res.status(201).json({ note: { id: n.id, visibility: n.visibility, text: n.text, at: n.at, actor: actorLabel(n.by) } });
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
      items: (tx.linkedThreads ?? []).map((t) => ({ id: t.id, channelId: t.channelId, linkedAt: t.linkedAt, actor: actorLabel(t.linkedBy), readable: channelReadableBy(t.channelId, viewer) })),
      note: 'Correspondence lives in the canonical ScoutBox Inbox. A link records that a conversation exists and who shared it; reading it still needs the Inbox\'s own authorisation, which transaction membership alone does not give. ScoutBox never negotiates and never replies for anyone.',
    });
  });

  // ============================================================ CLUB lane

  orgRouter.get('/transactions', (req, res) => {
    if (req.org.type !== 'club') return res.json({ items: [], note: 'Transaction party lanes are for club organisations.' });
    const viewer = clubViewer(req);
    const mine = db.agentTransactions.filter((t) => t && clubPartyRoleOf(t, req.org.id));
    res.json({
      items: mine.map((t) => projectTransaction(t, viewer)),
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
    const party = tx.parties.find((p) => !p.removed && p.subjectKind === 'club' && p.subjectId === req.org.id);
    if (!party) return notFound(res, 'confirm');
    if (party.confirmedAt) return res.json({ transaction: projectTransaction(tx, clubViewer(req)), idempotent: true });
    if (!guardRev(req, res, tx, { errorCode: 'TRANSACTION_VERSION_CONFLICT', current: { status: tx.status } })) return;
    party.confirmedAt = now(); party.confirmedBy = byClubUser(req);
    hist(party, 'transaction_party_confirmed', byClubUser(req), { partyRole: party.partyRole });
    hist(tx, 'transaction_party_confirmed', byClubUser(req), { partyRole: party.partyRole, subjectKind: 'club' });
    partyChanged(tx, byClubUser(req));
    broadcast('agent_transaction_party_changed', { orgId: tx.agencyOrgId, txId: tx.id, partyRole: party.partyRole });
    notify({ kind: 'org_user', id: tx.agentUserId }, 'agent_transaction', `A club confirmed its participation as the ${party.partyRole.replace(/_/g, ' ')} in a transaction.`, tx.id);
    bumpTxRev(tx, byClubUser(req)); persistNow();
    res.json({ transaction: projectTransaction(tx, clubViewer(req)) });
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
    const channelId = str(req.body?.channelId, 60);
    const ch = (db.channels ?? []).find((c) => c && c.id === channelId && c.orgId === req.org.id);
    const individual = tx.parties.find((p) => !p.removed && p.partyRole === 'individual');
    if (!ch || !individual || ch.playerId !== individual.subjectId) return sendTransactionError(res, { error: 'MESSAGE_THREAD_NOT_FOUND', message: 'No conversation of yours with this transaction\'s individual matches that reference.' }, 'messages');
    if ((tx.linkedThreads ?? []).some((t) => t.channelId === ch.id)) return res.json({ transaction: projectTransaction(tx, clubViewer(req)), idempotent: true });
    if ((tx.linkedThreads ?? []).length >= TRANSACTION_LIMITS.linkedThreads) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'channelId', message: 'This transaction already links the maximum number of conversations.' }, 'messages');
    if (!guardRev(req, res, tx, { errorCode: 'TRANSACTION_VERSION_CONFLICT', current: { status: tx.status } })) return;
    tx.linkedThreads ??= [];
    tx.linkedThreads.push({ id: nextId('txm'), channelId: ch.id, linkedBy: byClubUser(req), linkedAt: now() });
    hist(tx, 'transaction_message_linked', byClubUser(req), { count: tx.linkedThreads.length });
    broadcast('agent_transaction_message_linked', { orgId: tx.agencyOrgId, txId: tx.id });
    tx.updatedAt = now(); bumpTxRev(tx, byClubUser(req)); persistNow();
    res.status(201).json({ transaction: projectTransaction(tx, clubViewer(req)) });
  });
  /** Reference a trial of THIS club for THIS individual (§50). A reference only; no assessment crosses. */
  orgRouter.post('/transactions/:id/links', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id, { signatory: true }); if (!tx) return;
    if (!writableOr(res, tx, 'links')) return;
    const trialId = str(req.body?.trialId, 60);
    const individual = tx.parties.find((p) => !p.removed && p.partyRole === 'individual');
    const trial = (db.trials ?? []).find((t) => t && t.id === trialId && t.orgId === req.org.id && individual && t.playerId === individual.subjectId);
    if (!trial) return sendTransactionError(res, { error: 'TRANSACTION_INPUT_INVALID', field: 'trialId', message: 'No trial of yours with this transaction\'s individual matches that reference.' }, 'links');
    if (!guardRev(req, res, tx, { errorCode: 'TRANSACTION_VERSION_CONFLICT', current: { status: tx.status } })) return;
    tx.links ??= { trialId: null, opportunityId: null };
    tx.links.trialId = trial.id;
    hist(tx, 'transaction_status_changed', byClubUser(req), { from: tx.status, to: tx.status });
    tx.updatedAt = now(); bumpTxRev(tx, byClubUser(req)); persistNow();
    res.json({ transaction: projectTransaction(tx, clubViewer(req)) });
  });

  // ============================================================ PLAYER lane

  playerRouter.get('/transactions', (req, res) => {
    if (req.playerIsMinor) return res.json({ items: [], minor: true, note: 'Agent transactions are not available for under-18 accounts in ScoutBox.' });
    const viewer = playerViewer(req);
    const mine = db.agentTransactions.filter((t) => t && t.parties.some((p) => !p.removed && p.subjectKind === 'player' && p.subjectId === req.player.id));
    res.json({ items: mine.map((t) => projectTransaction(t, viewer)), statuses: TRANSACTION_STATUSES, honest: HONEST_TRANSACTION });
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
    const party = tx.parties.find((p) => !p.removed && p.subjectKind === 'player' && p.subjectId === req.player.id);
    if (!party) return notFound(res, 'confirm');
    if (party.confirmedAt) return res.json({ transaction: projectTransaction(tx, playerViewer(req)), idempotent: true });
    if (!guardRev(req, res, tx, { errorCode: 'TRANSACTION_VERSION_CONFLICT', current: { status: tx.status } })) return;
    party.confirmedAt = now(); party.confirmedBy = byPlayer(req);
    hist(party, 'transaction_party_confirmed', byPlayer(req), { partyRole: party.partyRole });
    hist(tx, 'transaction_party_confirmed', byPlayer(req), { partyRole: party.partyRole, subjectKind: 'player' });
    partyChanged(tx, byPlayer(req));
    broadcast('agent_transaction_party_changed', { orgId: tx.agencyOrgId, txId: tx.id, partyRole: party.partyRole });
    notify({ kind: 'org_user', id: tx.agentUserId }, 'agent_transaction', 'Your client confirmed their participation in a transaction.', tx.id);
    bumpTxRev(tx, byPlayer(req)); persistNow();
    res.json({ transaction: projectTransaction(tx, playerViewer(req)) });
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
  const tsView = (tx) => ({
    id: tx.id, type: tx.type, status: tx.status, jurisdictions: tx.jurisdictions,
    agencyOrgId: tx.agencyOrgId, agentUserId: tx.agentUserId,
    parties: tx.parties.map((p) => ({ partyRole: p.partyRole, subjectKind: p.subjectKind, removed: !!p.removed, confirmed: !!p.confirmedAt })),
    representations: repsOf(tx.id).map((r) => ({ partyRole: r.partyRole, status: r.status, declaredOnly: !!r.declaredOnly, reviewId: r.reviewId ?? null })),
    compliance: tx.compliance ? { outcome: tx.compliance.outcome, pendingReason: tx.compliance.pendingReason, blocked: tx.compliance.blocked, clear: tx.compliance.clear, reasonCodes: tx.compliance.reasonCodes, policyVersions: tx.compliance.policyVersions, evaluatedAt: tx.compliance.evaluatedAt, stale: snapshotStaleness(tx, currentPartyRevision(tx)) } : null,
    reviews: tx.contextId ? compliance.reviewsForContext(tx.contextId) : [],
    documentCount: docsOf(tx.id).length, noteCount: (tx.notes ?? []).filter((n) => !n.removedAt).length, linkedThreadCount: (tx.linkedThreads ?? []).length,
    createdAt: tx.createdAt, updatedAt: tx.updatedAt, rev: tx.rev,
  });
  tsRouter.get('/transactions', (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    res.json({ items: db.agentTransactions.filter((t) => t && (!status || t.status === status)).map(tsView), statuses: TRANSACTION_STATUSES, note: 'States, ids and party roles only. Transaction documents, notes, messages and terms are the parties\' and are not exposed here.' });
  });
  /** Process metrics only (§76): durations and counts. No agent is ranked and no player is ranked. */
  tsRouter.get('/transactions/metrics', (_req, res) => {
    const all = db.agentTransactions.filter(Boolean);
    const durations = all.filter((t) => TERMINAL_STATUSES.includes(t.status) && t.createdAt).map((t) => (t.cancelledAt ?? t.closedAt ?? t.updatedAt) - t.createdAt).sort((a, b) => a - b);
    const pendingSpans = [];
    const consentWaits = [];
    for (const t of all) {
      let pendingFrom = null;
      for (const h of t.history ?? []) {
        if (h.action !== 'transaction_status_changed') continue;
        if (h.detail?.to === 'COMPLIANCE_PENDING') pendingFrom = h.at;
        else if (pendingFrom && h.detail?.from === 'COMPLIANCE_PENDING') { pendingSpans.push(h.at - pendingFrom); pendingFrom = null; }
      }
      for (const k of t.contextId ? compliance.consentsFor(t.contextId) : []) {
        if (k.requestedAt && (k.grantedAt || k.declinedAt)) consentWaits.push((k.grantedAt ?? k.declinedAt) - k.requestedAt);
      }
    }
    const median = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
    res.json({
      byStatus: Object.fromEntries(TRANSACTION_STATUSES.map((s) => [s, all.filter((t) => t.status === s).length])),
      byType: Object.fromEntries(TRANSACTION_TYPES.map((k) => [k, all.filter((t) => t.type === k).length])),
      medianDurationMs: median(durations),
      medianCompliancePendingMs: median(pendingSpans),
      medianConsentWaitMs: median(consentWaits),
      cancellationReasons: Object.fromEntries(CANCEL_REASON_CODES.map((c) => [c, all.filter((t) => t.cancelReasonCode === c).length])),
      holdReasons: Object.fromEntries(HOLD_REASON_CODES.map((c) => [c, all.filter((t) => t.holdReasonCode === c).length])),
      staleSnapshots: all.filter((t) => LIVE_STATUSES.includes(t.status) && snapshotStaleness(t, currentPartyRevision(t))).length,
      note: 'Process metrics only. No agent, club or player is ranked, and no subscription or payment status enters any transaction outcome.',
    });
  });
  // Registered BEFORE the `:id` route, or Express would read "metrics" as an id.
  tsRouter.get('/transactions/:id', (req, res) => {
    const tx = txById(req.params.id);
    if (!tx) return notFound(res, 'ts');
    res.json({ transaction: tsView(tx), audit: transactionAuditRows(db, { transactionId: tx.id }).slice(0, TRANSACTION_LIMITS.historyPage) });
  });
  // ============================================================ lifecycle hooks

  /**
   * Player account removal (§71). The transaction keeps its shape — ids,
   * roles, states, times — and loses the person: the party row is tombstoned
   * and every actor label that named the player is emptied. Nothing is
   * resurrected into a list, because the projection reads the live player
   * record and finds none.
   */
  function onPlayerDeleted(playerId, at = now()) {
    for (const tx of db.agentTransactions) {
      if (!tx) continue;
      let touched = false;
      for (const p of tx.parties) {
        if (p.subjectKind !== 'player' || p.subjectId !== playerId) continue;
        p.removed = true; p.removedAt ??= at; p.subjectRemovedAt = at;
        if (p.confirmedBy?.kind === 'player') p.confirmedBy = { kind: 'player', userId: null, name: null };
        touched = true;
      }
      if (!touched) continue;
      for (const h of tx.history ?? []) if (h?.by?.kind === 'player') h.by = { kind: 'player', userId: null, name: null };
      for (const n of tx.notes ?? []) if (n?.by?.kind === 'player') n.by = { kind: 'player', userId: null, name: null };
      for (const d of db.transactionDocuments) {
        if (!d || d.transactionId !== tx.id) continue;
        if (d.owner?.kind === 'player' && d.owner.id === playerId) { d.removedAt ??= at; d.owner = { kind: 'player', id: null }; }
        if (d.uploadedBy?.kind === 'player') d.uploadedBy = { kind: 'player', userId: null, name: null };
      }
      for (const r of repsOf(tx.id)) if (r.status !== 'withdrawn') { r.status = 'withdrawn'; r.withdrawnAt = at; r.withdrawnReason = 'subject_removed'; }
      hist(tx, 'transaction_subject_tombstoned', bySystem('account deletion'), { partyRole: 'individual' });
      tx.updatedAt = at;
    }
  }

  /**
   * An attributed reviewer decided a declared-only binding (an entity client
   * with no ScoutBox agreement, P5.6A DR-18). The `transactionRepresentations`
   * row is the truth, so the decision lands here; the compliance context's
   * array is re-projected on the next evaluation.
   *
   * An approval records NO act by the agent: `firstActAt` stays null until the
   * agent themselves acts, so a later party-specific consent is still "in
   * advance" — the same rule P5.6C applies to its own review-verified rows.
   */
  function representationReviewed({ transactionId, representationId, outcome, by, reviewId }) {
    const tx = txById(transactionId);
    const rep = db.transactionRepresentations.find((r) => r && r.id === representationId && r.transactionId === transactionId);
    if (!tx || !rep || rep.status !== 'pending_review') return;
    if (outcome === 'APPROVED') { rep.status = 'verified'; rep.declaredOnly = false; rep.verifiedAt = now(); rep.verifiedByReviewId = reviewId; }
    else { rep.status = 'withdrawn'; rep.withdrawnAt = now(); rep.withdrawnReason = 'review_rejected'; }
    hist(rep, outcome === 'APPROVED' ? 'transaction_representation_attached' : 'transaction_representation_withdrawn', by, { partyRole: rep.partyRole, status: rep.status });
    hist(tx, outcome === 'APPROVED' ? 'transaction_representation_attached' : 'transaction_representation_withdrawn', by, { partyRole: rep.partyRole, status: rep.status });
    bumpTxRev(rep, by);
    if (LIVE_STATUSES.includes(tx.status)) recheckCompliance(tx, by);
    tx.updatedAt = now();
  }

  return {
    onPlayerDeleted, representationReviewed,
    hooks: { auditRows: (org) => transactionAuditRows(db, { agencyOrgId: org.id }) },
    transactionAuditRows: (filter) => transactionAuditRows(db, filter),
  };
}
