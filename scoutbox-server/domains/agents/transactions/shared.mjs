/**
 * What the transaction lanes share: the compliance snapshot of a transaction, its projection for each viewer, the
 * resolution of a transaction for each lane and of a party, and the move a party change forces.
 */

import { guardRev, revMeta } from '../../platform/concurrency.mjs';
import { pageOf } from '../../platform/paging.mjs';
import { isExpiredAt } from '../../../temporal.mjs';
import { hasVerLevel } from '../../verification/public.mjs';
import { can } from '../core/shared.mjs';
import { sendTransactionError, notFound } from './errors.mjs';
import {
  partiesOf,
  LIVE_STATUSES,
  TERMINAL_STATUSES,
  ACTOR_TRANSITIONS,
  complianceTransitionAllowed,
  canSeeVisibility,
  complianceStateFrom,
  statusForComplianceState,
  partyRevisionOf,
  snapshotStaleness,
  snapshotView,
  offerReadiness,
  requiredPartyRoles,
  partiesConfirmed,
  partiesAwaitingConfirmation,
  roomRolesFor,
  clubPartyRoleOf,
  actorLabel,
  RELEASING_PARTY_TYPES,
} from './transaction.mjs';
import { now } from '../../platform/clock.mjs';

export const HONEST_TRANSACTION =
  'A ScoutBox transaction is a permissioned workspace. "Ready" means ScoutBox currently permits this workflow to proceed under the encoded rules — it is not a statement of legal validity, no governing body has approved anything, no offer exists and nothing has been signed.';
/** A refusal after a write that must not stand: the unit rolls back; the answer was already sent. */
export const ROLLBACK = Symbol('transaction rollback');

export function createTransactionShared(ctx) {
  const {
    access,
    broadcast,
    byAgent,
    bySystem,
    channels,
    compliance,
    docsOf,
    docsRepo,
    entry,
    findPlayer,
    integration,
    isAdult,
    isBlocked,
    liveRepsOf,
    nextId,
    notify,
    orgById,
    orgCanSee,
    repsOf,
    repsRepo,
    txById,
    txs,
    verificationReads,
  } = ctx;

  const complianceOf = (tx) =>
    snapshotView(
      tx,
      tx.compliance,
      tx.compliance?.evaluationId ? compliance.evaluationById(tx.compliance.evaluationId) : null,
    );

  /**
   * The hash staleness is measured against. Recomputed from live records, never cached: a cached revision is exactly
   * the stale fact it exists to detect.
   */
  function currentPartyRevision(tx, { reps = null } = {}) {
    const consents = compliance.consentsFor(tx.contextId);
    const blocked = [];
    const minors = [];
    for (const p of partiesOf(tx)) {
      if (p.removed || p.subjectKind !== 'player') continue;
      const pl = findPlayer(p.subjectId);
      if (!pl) {
        blocked.push(p.subjectId);
        continue;
      }
      if (isBlocked(pl.id, tx.agencyOrgId)) blocked.push(pl.id);
      if (!isAdult(pl)) minors.push(pl.id);
    }
    return partyRevisionOf({
      parties: partiesOf(tx),
      agentUserId: tx.agentUserId,
      representations: reps ?? repsOf(tx.id),
      consents: consents.map((k) => ({ id: k.id, status: k.status })),
      facetStates: compliance.facetStatesFor(tx.agentUserId) ?? {},
      policyVersions: compliance.lastEvaluation(compliance.contextById(tx.contextId) ?? {})?.policyVersions ?? [],
      blockedSubjectIds: blocked,
      minorSubjectIds: minors,
    });
  }

  /**
   * Checked before relationship scope and the engine, and refused with the uniform concealment answer so "blocked"
   * reads as "does not exist". It lives here, not in the conflict engine, so a regulatory clear cannot override it.
   */
  function safeguardingProblem(tx) {
    for (const p of partiesOf(tx)) {
      if (p.removed || p.subjectKind !== 'player') continue;
      const pl = findPlayer(p.subjectId);
      if (!pl) return 'SUBJECT_GONE';
      if (isBlocked(pl.id, tx.agencyOrgId)) return 'BLOCKED';
      // No minor transaction pathway is enabled in any jurisdiction (MINOR_PATHWAY_PRODUCTION_ENABLED).
      if (!isAdult(pl)) return 'MINOR';
      const org = orgById(tx.agencyOrgId);
      if (!org || !orgCanSee(org, pl)) return 'NOT_VISIBLE';
    }
    return null;
  }

  /** Called after every material mutation's own act, so an old evaluation can never authorise a new mutation. */
  function recheckCompliance(txId, by) {
    const tx = txById(txId);
    const ctx = compliance.contextById(tx.contextId);
    const reps = liveRepsOf(tx.id);
    const confirmed = partiesConfirmed(tx);
    const guard = safeguardingProblem(tx);
    if (guard) {
      // Not a compliance verdict: the snapshot is not refreshed, and the caller answers the uniform 404.
      return { safeguarding: guard, state: null, result: null, tx };
    }
    const gate = compliance.facetGateProblem(tx.agentUserId, tx.jurisdictions);
    if (gate) {
      const state = complianceStateFrom({
        gate: gate.gate ?? 'FACET_NOT_VERIFIED',
        reasons: gate.reasons ?? [],
        partiesConfirmed: confirmed,
        representationCount: reps.length,
      });
      return {
        safeguarding: null,
        state,
        result: null,
        gateProblem: gate,
        tx: applyComplianceSnapshot(tx, { state, result: null, ctx, by }),
      };
    }
    if (!ctx)
      return {
        safeguarding: null,
        state: complianceStateFrom({ gate: 'REPRESENTATION_MISSING', partiesConfirmed: confirmed }),
        result: null,
        tx,
      };
    compliance.project(ctx, { parties: partiesOf(tx), representations: reps });
    const result = compliance.evaluate(ctx, by);
    const state = complianceStateFrom({
      outcome: result.outcome,
      reasons: result.reasons,
      consentsOutstanding: result.consentsOutstanding,
      representationCount: reps.length,
      partiesConfirmed: confirmed,
    });
    return { safeguarding: null, state, result, tx: applyComplianceSnapshot(tx, { state, result, ctx, by }) };
  }

  /** The status moves through the compliance transition map only: no actor reaches READY or the COMPLIANCE_* states. */
  function applyComplianceSnapshot(tx, { state, result, ctx, by }) {
    const prev = complianceOf(tx)?.state ?? null;
    const actor = by ?? bySystem('compliance re-evaluation');
    const snapshot = {
      evaluationId: result ? result.evaluationId : null,
      gate: result ? null : state.pendingReason,
      evaluatedAt: now(),
      pendingReason: state.pendingReason ?? null,
      verificationFreshness: compliance.facetStatesFor(tx.agentUserId)?.fifa_licence ?? null,
      partyRevision: currentPartyRevision(tx),
    };
    if (ctx) compliance.clearReEvaluation(ctx);
    const want = statusForComplianceState(state);
    const to = want && want !== tx.status && complianceTransitionAllowed(tx.status, want) ? want : null;
    const history = [
      ...(to
        ? [
            entry('transaction_status_changed', actor, {
              from: tx.status,
              to,
              pendingReason: state.pendingReason ?? null,
              outcome: state.outcome ?? null,
            }),
          ]
        : []),
      entry('transaction_compliance_evaluated', actor, {
        outcome: state.outcome ?? null,
        pendingReason: state.pendingReason ?? null,
        reasonCodes: state.reasonCodes,
        policyVersions: result?.policyVersions ?? [],
      }),
    ];
    const stored = txs.recordCompliance(tx.id, { snapshot, to }, { at: now(), touch: true, history });
    if (to) broadcast('agent_transaction_status_changed', { orgId: tx.agencyOrgId, txId: tx.id, status: to });
    if (JSON.stringify(prev) !== JSON.stringify(state)) {
      broadcast('agent_transaction_compliance_updated', {
        orgId: tx.agencyOrgId,
        txId: tx.id,
        outcome: state.outcome ?? 'NONE',
      });
      notify(
        { kind: 'org_user', id: tx.agentUserId },
        'agent_transaction_compliance',
        state.blocked
          ? 'A transaction is blocked by an encoded ACTIVE rule. It cannot progress; only changed facts or a new policy version produce a different answer.'
          : state.clear
            ? 'A transaction is compliance-clear under the currently encoded rules. Nothing has been approved, agreed or signed.'
            : `A transaction cannot currently progress: ${String(state.pendingReason ?? 'compliance pending')
                .replace(/_/g, ' ')
                .toLowerCase()}.`,
        tx.id,
      );
    }
    return stored;
  }

  /**
   * Reported on a read, never repaired. A new policy version flags the compliance context, which reads here as
   * POLICY_CHANGED beside the transaction's own flag.
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

  /** Asked before a club is shown a case reference, so it sees only its own case id, never one copied from elsewhere. */
  const recruitmentCaseBelongsTo = (caseId, orgId) =>
    integration?.caseBelongsTo ? integration.caseBelongsTo(caseId, orgId) === true : false;

  const batchFor = (list) => {
    const ids = list.map((t) => t.id);
    const reps = repsRepo.forTransactions(ids);
    const docs = docsRepo.liveForTransactions(ids);
    return { reps, docs };
  };

  /** One transaction, projected for one viewer from the roles the server derived. */
  function projectTransaction(tx, viewer, batch = null) {
    const roles = roomRolesFor(tx, viewer);
    const partyRole =
      viewer.kind === 'club' ? clubPartyRoleOf(tx, viewer.orgId) : viewer.kind === 'player' ? 'individual' : null;
    const reps = batch ? batch.reps(tx.id) : repsOf(tx.id);
    const liveDocs = batch ? batch.docs(tx.id) : docsOf(tx.id);
    const view = complianceOf(tx);
    const stale = stalenessOf(tx, { view, reps });
    const state = view?.state ?? null;
    const live = partiesOf(tx).filter((p) => !p.removed);
    const isAgent = roles.includes('representing_agent');
    const consents = compliance.consentsFor(tx.contextId);
    return {
      id: tx.id,
      type: tx.type,
      status: tx.status,
      jurisdictions: tx.jurisdictions,
      // Conveniences derived from parties[], which stays the truth.
      playerId: live.find((p) => p.partyRole === 'individual')?.subjectId ?? null,
      engagingOrgId: live.find((p) => p.partyRole === 'engaging_entity')?.subjectId ?? null,
      releasingOrgId: live.find((p) => p.partyRole === 'releasing_entity')?.subjectId ?? null,
      viewerRoles: roles,
      viewerPartyRole: partyRole,
      // Every party is entitled to know who represents whom.
      agency: isAgent || roles.length ? { id: tx.agencyOrgId, name: orgById(tx.agencyOrgId)?.name ?? null } : null,
      parties: partiesOf(tx).map((p) => ({
        id: p.id,
        partyRole: p.partyRole,
        subjectKind: p.subjectKind,
        subjectId: p.subjectId,
        name: partyName(p, viewer),
        removed: !!p.removed,
        removedAt: p.removedAt ?? null,
        confirmedAt: p.confirmedAt ?? null,
        confirmedByKind: p.confirmedBy?.kind ?? null,
        addedAt: p.addedAt,
        subjectRemovedAt: p.subjectRemovedAt ?? null,
      })),
      requiredPartyRoles: requiredPartyRoles(tx.type),
      awaitingConfirmation: partiesAwaitingConfirmation(tx),
      partiesConfirmed: partiesConfirmed(tx),
      // Every party sees who represents which party and on what basis, never fee terms. The agreement id is the
      // agent's own reference.
      representations: reps.map((r) => ({
        id: r.id,
        partyRole: r.partyRole,
        agentUserId: r.agentUserId,
        status: r.status,
        declaredOnly: !!r.declaredOnly,
        basis: r.agreementId ? 'client_confirmed_agreement' : 'declared',
        scope: r.scope ?? [],
        jurisdictions: r.jurisdictions ?? [],
        verifiedAt: r.verifiedAt ?? null,
        withdrawnAt: r.withdrawnAt ?? null,
        createdAt: r.createdAt,
        ...(isAgent
          ? { agreementId: r.agreementId ?? null, reviewId: r.reviewId ?? null, firstActAt: r.firstActAt ?? null }
          : {}),
      })),
      // `clear` is the current answer, so a client reading only it is never told a stale snapshot clears the
      // transaction; `snapshotClear` keeps what the last evaluation said.
      compliance: state
        ? {
            outcome: state.outcome,
            pendingReason: stale ? (state.pendingReason ?? 'SNAPSHOT_STALE') : state.pendingReason,
            blocked: state.blocked,
            clear: state.clear && !stale,
            snapshotClear: state.clear,
            reasonCodes: state.reasonCodes,
            consentRequirements: view.consentRequirements,
            evaluatedAt: view.evaluatedAt,
            stale,
            staleness: stale,
            ...(isAgent
              ? {
                  evaluationId: view.evaluationId,
                  contextId: view.contextId,
                  policyVersions: view.policyVersions,
                  verificationFreshness: view.verificationFreshness,
                }
              : {}),
            honest:
              "ScoutBox has evaluated its own encoded rules. It has not determined anyone's legal rights and no governing body has approved anything.",
          }
        : {
            outcome: null,
            pendingReason: 'PARTIES_NOT_CONFIRMED',
            blocked: false,
            clear: false,
            reasonCodes: [],
            consentRequirements: [],
            evaluatedAt: null,
            stale: 'NO_SNAPSHOT',
            staleness: 'NO_SNAPSHOT',
            honest: 'No compliance evaluation has been recorded for this transaction yet.',
          },
      // A party sees its own consent in full and another party's as a state only.
      consents: consents.map((k) => {
        const mine =
          (viewer.kind === 'player' && k.subject?.kind === 'player' && k.subject.id === viewer.playerId) ||
          (viewer.kind === 'club' && k.subject?.kind === 'club' && k.subject.id === viewer.orgId);
        return {
          id: mine || isAgent ? k.id : null,
          kind: k.kind,
          partyRole: k.partyRole,
          status: k.status,
          requestedAt: k.requestedAt ?? null,
          grantedAt: k.grantedAt ?? null,
          declinedAt: k.declinedAt ?? null,
          revokedAt: k.revokedAt ?? null,
          mine: !!mine,
          ...(mine ? { particulars: k.particulars ?? null, policyVersions: k.policyVersions ?? [] } : {}),
        };
      }),
      documents: liveDocs
        .filter((d) => canSeeVisibility(d.visibility, roles, partyRole) && !d.supersededBy)
        .map((d) => documentView(d, roles, partyRole)),
      // Absent, not redacted, so a hidden note's existence is not disclosed.
      notes: tx.notes
        .filter((n) => canSeeVisibility(n.visibility, roles, partyRole))
        .map((n) => ({ id: n.id, visibility: n.visibility, text: n.text, at: n.at, actor: actorLabel(n.by) })),
      linkedThreads: tx.linkedThreads.map((t) => ({
        id: t.id,
        channelId: t.channelId,
        linkedAt: t.linkedAt,
        actor: actorLabel(t.linkedBy),
        readable: channelReadableBy(t.channelId, viewer),
      })),
      // The recruitment case is club-private: only the agent and the club that owns it see the reference. A
      // releasing club in particular must not learn the engaging club's internal case. Absent, not redacted.
      links: {
        trialId: tx.links.trialId ?? null,
        opportunityId: tx.links.opportunityId ?? null,
        ...(tx.links.recruitmentCaseId &&
        (isAgent ||
          (viewer.kind === 'club' &&
            partyRole === 'engaging_entity' &&
            recruitmentCaseBelongsTo(tx.links.recruitmentCaseId, viewer.orgId)))
          ? { recruitmentCaseId: tx.links.recruitmentCaseId }
          : {}),
      },
      terms:
        isAgent || roles.includes('party_club_signatory') || roles.includes('party_individual')
          ? {
              versions: tx.terms.versions
                .filter((v) => canSeeVisibility(v.visibility, roles, partyRole))
                .map((v) => ({
                  id: v.id,
                  at: v.at,
                  summary: v.summary,
                  visibility: v.visibility,
                  recordedFor: v.recordedFor,
                  actor: actorLabel(v.by),
                })),
            }
          : { versions: [] },
      offerBoundary: offerReadiness(tx, { complianceState: state, staleness: stale }),
      hold:
        tx.status === 'ON_HOLD'
          ? {
              reasonCode: tx.holdReasonCode ?? null,
              reason: roles.length ? (tx.holdReason ?? null) : null,
              at: tx.heldAt ?? null,
            }
          : null,
      cancelReasonCode: tx.cancelReasonCode ?? null,
      closeReasonCode: tx.closeReasonCode ?? null,
      allowedTransitions: allowedTransitionsFor(tx, roles),
      initiatedBy: tx.initiatedBy?.kind ?? null,
      initiatedAt: tx.initiatedAt,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
      ...revMeta(tx),
      honest: HONEST_TRANSACTION,
    };
  }

  const documentView = (d, roles, partyRole) => ({
    id: d.id,
    documentType: d.documentType,
    visibility: d.visibility,
    version: d.version,
    label: d.label,
    ownerKind: d.owner?.kind ?? null,
    ownerPartyRole: d.ownerPartyRole ?? null,
    uploadedAt: d.createdAt,
    actor: actorLabel(d.uploadedBy),
    expiresAt: d.expiresAt ?? null,
    expired: isExpiredAt(d.expiresAt, now()), // an unreadable expiry reads expired, never "current"
    // No writer objectively knows a signature instant, so none is claimed.
    signedAt: null,
    supersedes: d.supersedes ?? null,
    evidence: d.evidenceRef ? { kind: d.evidenceRef.kind, present: true } : null,
    downloadable: !!d.evidenceRef && canSeeVisibility(d.visibility, roles, partyRole),
    ...revMeta(d),
  });

  /** Transaction membership does not make a linked thread readable: the Inbox's own gate decides. */
  function channelReadableBy(channelId, viewer) {
    const ch = channels.byId(channelId);
    if (!ch) return false;
    if (viewer.kind === 'player') return ch.playerId === viewer.playerId && ch.counterparty === 'player';
    if (viewer.kind === 'club') return ch.orgId === viewer.orgId;
    return false;
  }

  function allowedTransitionsFor(tx, roles) {
    if (!roles.includes('representing_agent')) return [];
    return (ACTOR_TRANSITIONS[tx.status] ?? []).slice();
  }

  // ============================================================ resolution + authorization

  function ownTransaction(req, res, id, { write = false } = {}) {
    if (!access.resolveMembership(req, res)) return null;
    if (!access.requireCap(req, res, write ? 'transactions.write' : 'transactions.read')) return null;
    const tx = txById(id);
    // A colleague's transaction is 404, not 403, so a colleague's client work is not disclosed.
    if (!tx || tx.agencyOrgId !== req.org.id || tx.agentUserId !== req.orgUser.id) {
      notFound(res, 'transaction');
      return null;
    }
    return tx;
  }

  function clubTransaction(req, res, id, { signatory = false } = {}) {
    if (req.org.type !== 'club') {
      notFound(res, 'transaction');
      return null;
    }
    const tx = txById(id);
    const role = tx ? clubPartyRoleOf(tx, req.org.id) : null;
    if (!tx || !role) {
      notFound(res, 'transaction');
      return null;
    }
    if (signatory && !hasVerLevel(verificationReads, req.org.id, req.orgUser.id, 'verification_admin')) {
      sendTransactionError(
        res,
        {
          error: 'SIGNATORY_REQUIRED',
          message: 'Only a recorded club signatory (a verification administrator) may act for the club here.',
        },
        'transaction',
      );
      return null;
    }
    req.txPartyRole = role;
    return tx;
  }

  function playerTransaction(req, res, id) {
    if (req.playerIsMinor) {
      notFound(res, 'transaction');
      return null;
    }
    const tx = txById(id);
    if (!tx || !partiesOf(tx).some((p) => !p.removed && p.subjectKind === 'player' && p.subjectId === req.player.id)) {
      notFound(res, 'transaction');
      return null;
    }
    return tx;
  }

  const clubViewer = (req) => ({
    kind: 'club',
    orgId: req.org.id,
    userId: req.orgUser.id,
    signatory: hasVerLevel(verificationReads, req.org.id, req.orgUser.id, 'verification_admin'),
  });
  const agentViewer = (req) => ({
    kind: 'agency',
    orgId: req.org.id,
    userId: req.orgUser.id,
    agencyAdmin: can(req.tiers, 'agency.compliance.read'),
  });
  const playerViewer = (req) => ({ kind: 'player', playerId: req.player.id });

  function writableOr(res, tx, where) {
    const guard = safeguardingProblem(tx);
    // The record stays readable; the write stops with one answer for removed, invisible, blocked and minor, so the
    // refusal is not an oracle.
    if (guard) {
      sendTransactionError(
        res,
        {
          error: 'TRANSACTION_PARTY_UNAVAILABLE',
          message:
            'A party to this transaction is no longer available to your organisation. Nothing further can be written to it; its record stays.',
        },
        where,
      );
      return false;
    }
    if (tx.status === 'ARCHIVED') {
      sendTransactionError(
        res,
        { error: 'TRANSACTION_ARCHIVED', status: tx.status, message: 'An archived transaction is read-only.' },
        where,
      );
      return false;
    }
    if (!LIVE_STATUSES.includes(tx.status)) {
      sendTransactionError(
        res,
        {
          error: 'TRANSACTION_NOT_LIVE',
          status: tx.status,
          message: 'This transaction has ended. Its record stays; nothing further can be written to it.',
        },
        where,
      );
      return false;
    }
    return true;
  }
  /** A stale rev answers 409 and rolls back whatever the unit already wrote. */
  const guardRevOrRollback = (req, res, record, opts) => {
    if (!guardRev(req, res, record, opts)) throw ROLLBACK;
  };
  const TX_CONFLICT = (tx) => ({ errorCode: 'TRANSACTION_VERSION_CONFLICT', current: { status: tx.status } });

  // ============================================================ party resolution

  /**
   * A missing player, a minor, an invisible player and one who blocked the agency all answer the same 404, so the
   * route is not an age or a block oracle.
   */
  function resolveParty(req, res, raw, { type }) {
    const { partyRole, subjectKind, subjectId } = raw;
    if (partyRole === 'releasing_entity' && !RELEASING_PARTY_TYPES.includes(type)) {
      sendTransactionError(
        res,
        {
          error: 'TRANSACTION_INPUT_INVALID',
          field: 'partyRole',
          message: 'A releasing entity exists only in a transfer or a loan.',
        },
        'party',
      );
      return null;
    }
    const party = (id) => ({
      id: nextId('txp'),
      partyRole,
      subjectKind,
      subjectId: id,
      addedAt: now(),
      addedBy: byAgent(req),
      removed: false,
      removedAt: null,
      confirmedAt: null,
      confirmedBy: null,
      subjectRemovedAt: null,
    });
    if (subjectKind === 'player') {
      if (partyRole !== 'individual') {
        sendTransactionError(
          res,
          { error: 'TRANSACTION_INPUT_INVALID', field: 'partyRole', message: 'A player is the individual party.' },
          'party',
        );
        return null;
      }
      const pl = findPlayer(subjectId);
      if (!pl || !isAdult(pl) || !orgCanSee(req.org, pl) || isBlocked(pl.id, req.org.id)) {
        sendTransactionError(
          res,
          { error: 'TRANSACTION_PARTY_NOT_FOUND', message: 'No such party is available to you.' },
          'party',
        );
        return null;
      }
      return party(pl.id);
    }
    if (partyRole === 'individual') {
      sendTransactionError(
        res,
        {
          error: 'TRANSACTION_INPUT_INVALID',
          field: 'partyRole',
          message: 'A club is an engaging or a releasing entity.',
        },
        'party',
      );
      return null;
    }
    const org = orgById(subjectId);
    if (!org || org.type !== 'club') {
      sendTransactionError(
        res,
        { error: 'TRANSACTION_PARTY_NOT_FOUND', message: 'No such party is available to you.' },
        'party',
      );
      return null;
    }
    return party(org.id);
  }

  function notifyParty(tx, party, type, message) {
    if (party.subjectKind === 'player') notify({ kind: 'player', id: party.subjectId }, type, message, tx.id);
    else
      for (const u of verificationReads.admins.activeForOrg(party.subjectId))
        notify({ kind: 'org_user', id: u.userId }, type, message, tx.id);
  }

  /** Without the integration seam (a suite booting transactions alone), nothing is a duplicate. */
  const duplicateOf = ({ individualId, type, engagingOrgId, releasingOrgId }) =>
    integration?.duplicateTransactionOf
      ? integration.duplicateTransactionOf(txs.liveForIndividual(individualId, type), {
          clientId: individualId,
          type,
          engagingOrgId,
          releasingOrgId,
          terminalStatuses: TERMINAL_STATUSES,
          partiesOf: (t) => t.parties,
        })
      : null;

  const pageItems = (rows, limit) => {
    const p = pageOf(rows, limit, (r) => r.key);
    return { records: p.items.map((r) => r.record), nextCursor: p.nextCursor };
  };

  /** A transaction that loses its confirmation set falls back out of READY/ACTIVE, and compliance is re-evaluated. */
  function partyChanged(txId, by) {
    let tx = txById(txId);
    if (!partiesConfirmed(tx) && ['READY', 'ACTIVE', 'COMPLIANCE_PENDING', 'COMPLIANCE_BLOCKED'].includes(tx.status)) {
      const from = tx.status;
      tx = txs.moveOnPartyChange(
        tx.id,
        { to: 'PARTIES_CONFIRMED' },
        {
          history: [
            entry('transaction_status_changed', by, {
              from,
              to: 'PARTIES_CONFIRMED',
              pendingReason: 'PARTIES_NOT_CONFIRMED',
            }),
          ],
        },
      );
      broadcast('agent_transaction_status_changed', { orgId: tx.agencyOrgId, txId: tx.id, status: tx.status });
    }
    if (tx.status === 'DRAFT' && partiesConfirmed(tx)) {
      tx = txs.moveOnPartyChange(
        tx.id,
        { to: 'PARTIES_CONFIRMED' },
        { history: [entry('transaction_status_changed', by, { from: 'DRAFT', to: 'PARTIES_CONFIRMED' })] },
      );
      broadcast('agent_transaction_status_changed', { orgId: tx.agencyOrgId, txId: tx.id, status: tx.status });
    }
    return recheckCompliance(tx.id, by);
  }

  return {
    complianceOf,
    recheckCompliance,
    applyComplianceSnapshot,
    safeguardingProblem,
    stalenessOf,
    batchFor,
    projectTransaction,
    documentView,
    channelReadableBy,
    ownTransaction,
    clubTransaction,
    playerTransaction,
    agentViewer,
    clubViewer,
    playerViewer,
    writableOr,
    guardRevOrRollback,
    TX_CONFLICT,
    resolveParty,
    notifyParty,
    duplicateOf,
    pageItems,
    partyChanged,
  };
}
