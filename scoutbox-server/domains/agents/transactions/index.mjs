/**
 * Agent transaction workspace routes: the agent, club-party, player-party and Trust & Safety lanes.
 *
 * Every write route is one unit of work: a refusal after a write that must not stand rolls the whole unit back; a
 * refusal that records a compliance answer commits it.
 */

import { apartFromTheAct } from '../../../writeRules.mjs';
import { guardRev, revMeta } from '../../platform/concurrency.mjs';
import { refuseWhenLimited } from '../../platform/rateLimit.mjs';
import { readPage, pageOf, sendPageError } from '../../platform/paging.mjs';
import { normaliseClientKey, payloadFingerprint } from '../../platform/idempotency.mjs';
import { isExpiredAt, isAbsent, parseDateOrInstant } from '../../../temporal.mjs';
import { parseInput, filled } from '../../platform/schemas.mjs';
import { TRANSACTION_INPUT, transactionParseOptions } from './schemas.mjs';
import { hasVerLevel } from '../../verification/public.mjs';
import { effectiveAgreementStatus, agreementGrantsAccess, can } from '../core/shared.mjs';
import { sendTransactionError, notFound } from './errors.mjs';
import { transactionAuditRows } from './audit.mjs';
import {
  partiesOf,
  TRANSACTION_TYPES,
  TRANSACTION_STATUSES,
  LIVE_STATUSES,
  TERMINAL_STATUSES,
  PARTY_ROLES,
  ROOM_ROLES,
  ACTOR_TRANSITIONS,
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
  snapshotView,
  offerReadiness,
  requiredPartyRoles,
  partiesConfirmed,
  partiesAwaitingConfirmation,
  roomRolesFor,
  clubPartyRoleOf,
  timelineFor,
  actorLabel,
  HOLD_REASON_CODES,
  CANCEL_REASON_CODES,
  CLOSE_REASON_CODES,
  TRANSACTION_LIMITS,
  RELEASING_PARTY_TYPES,
  PENDING_REASONS,
} from './transaction.mjs';
import { now } from '../../platform/clock.mjs';

const HONEST_TRANSACTION =
  'A ScoutBox transaction is a permissioned workspace. "Ready" means ScoutBox currently permits this workflow to proceed under the encoded rules — it is not a statement of legal validity, no governing body has approved anything, no offer exists and nothing has been signed.';
/** A refusal after a write that must not stand: the unit rolls back; the answer was already sent. */
const ROLLBACK = Symbol('transaction rollback');
const REASON_CODES_FOR = Object.freeze({
  ON_HOLD: HOLD_REASON_CODES,
  CANCELLED: CANCEL_REASON_CODES,
  CLOSED: CLOSE_REASON_CODES,
});

export function registerTransactions(rawCtx) {
  const {
    byId,
    orgRouter,
    playerRouter,
    tsRouter,
    nextId,
    notify,
    broadcast,
    findPlayer,
    isBlocked,
    isAdult,
    orgCanSee,
    rateLimit,
    access,
    compliance,
    // Absent, a transaction may not cite a recruitment case at all.
    integration = null,
    recruitmentReads,
    scoutingReads,
    agentTransactions,
    unit,
    channels, // a linked thread's own authorisation is read from the message threads
  } = rawCtx;
  if (typeof agentTransactions?.transactions?.recordAct !== 'function' || typeof unit !== 'function')
    throw new TypeError('registerTransactions needs the agent transactions repository and unit from the data layer');
  if (typeof compliance?.onRepresentationReviewed !== 'function')
    throw new TypeError("registerTransactions needs the compliance engine's transaction seam (ctx.compliance)");
  compliance.onRepresentationReviewed(representationReviewed);
  const { transactions: txs, representations: repsRepo, documents: docsRepo } = agentTransactions;

  const entry = (action, by, detail = null) => ({ id: nextId('aud'), at: now(), action, by, detail });
  const byAgent = (req) => ({ kind: 'org', userId: req.orgUser.id, name: req.orgUser.name });
  const byClubUser = (req) => ({
    kind: 'club_user',
    userId: req.orgUser.id,
    name: req.orgUser.name,
    orgId: req.org.id,
  });
  const byPlayer = (req) => ({ kind: 'player', userId: req.player.id, name: req.player.name });
  const bySystem = (name) => ({ kind: 'system', userId: null, name });
  const limitedOr429 = refuseWhenLimited(rateLimit);
  /** The request input read with its schema (TRANSACTION_INPUT), or `undefined` once the refusal is sent. */
  const inputOr400 = (res, name, input, root = 'body') => {
    const parsed = parseInput(TRANSACTION_INPUT[name], input ?? {}, transactionParseOptions(name, root));
    if (parsed.ok) return parsed.value;
    sendTransactionError(res, parsed, name);
    return undefined;
  };
  const clientKeyOr400 = (body, res) => {
    const k = normaliseClientKey(body.clientKey);
    if (!k.ok) {
      sendTransactionError(res, { error: 'TRANSACTION_CLIENT_KEY_INVALID', message: k.message }, 'clientKey');
      return undefined;
    }
    return k.key;
  };
  /** Text a schema has read, trimmed; '' when blank or absent. */
  const text = (v) => filled(v) ?? '';
  const refuse = (res, out, where) => {
    sendTransactionError(res, out, where);
    throw ROLLBACK;
  };
  /** `work` returns the function that answers once the unit has committed. */
  const inUnit = (work) => {
    let reply;
    try {
      reply = unit(work);
    } catch (e) {
      if (e === ROLLBACK) return;
      throw e;
    }
    if (typeof reply === 'function') reply();
  };

  /**
   * The rev is labelled with a role, not a person: every party sees it, and a person's name would tell the individual
   * who at the club last touched the record (and a club who at the agency). The audit keeps the real actor.
   */
  const roleRev = (by) => ({ at: now(), label: actorLabel(by)?.label ?? null });
  const txBook = (by, history = [], { touch = false } = {}) => ({ at: now(), touch, history });
  const bumpTx = (txId, by) => txs.recordAct(txId, { bump: roleRev(by) });
  /** On a binding or a document: labelled with the role, or with `revBy` (a person) when given. */
  const rowBook = (by, history = [], revBy = null) => ({
    history,
    bump: { at: now(), by: revBy ?? { userId: null, name: roleRev(by).label } },
  });

  const txById = (id) => (typeof id === 'string' ? txs.byId(id) : null);
  const repsOf = (txId) => repsRepo.forTransaction(txId);
  const liveRepsOf = (txId) => repsOf(txId).filter((r) => r.status !== 'withdrawn');
  const docsOf = (txId) => docsRepo.forTransaction(txId).filter((d) => !d.removedAt);
  const orgById = (id) => byId.org(id) ?? null;

  // ============================================================ compliance integration

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
    if (signatory && !hasVerLevel(rawCtx.verificationReads, req.org.id, req.orgUser.id, 'verification_admin')) {
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
    signatory: hasVerLevel(rawCtx.verificationReads, req.org.id, req.orgUser.id, 'verification_admin'),
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
      for (const u of rawCtx.verificationReads.admins.activeForOrg(party.subjectId))
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

  // ============================================================ AGENT lane

  orgRouter.get('/agent/transactions', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    if (!access.requireCap(req, res, 'transactions.read')) return;
    const q = inputOr400(res, 'list', req.query, 'query');
    if (!q) return;
    const status = q.status ?? null;
    let pageReq;
    try {
      pageReq = readPage(q, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    // A colleague's transactions are neither listed nor counted. The counts cover all the agent's, not this page.
    const { records, nextCursor } = pageItems(
      txs.agentPage({ agencyOrgId: req.org.id, agentUserId: req.orgUser.id, status, ...pageReq }).rows,
      pageReq.limit,
    );
    const viewer = agentViewer(req);
    const batch = batchFor(records);
    res.json({
      items: records.map((t) => projectTransaction(t, viewer, batch)),
      nextCursor,
      statuses: TRANSACTION_STATUSES,
      types: TRANSACTION_TYPES,
      partyRoles: PARTY_ROLES,
      documentTypes: DOCUMENT_TYPES,
      visibilities: DOCUMENT_VISIBILITY,
      roomRoles: ROOM_ROLES,
      holdReasonCodes: HOLD_REASON_CODES,
      cancelReasonCodes: CANCEL_REASON_CODES,
      closeReasonCodes: CLOSE_REASON_CODES,
      transitions: ALL_TRANSITIONS,
      pendingReasons: PENDING_REASONS,
      counts: txs.agentCounts(req.org.id, req.orgUser.id),
      honest: HONEST_TRANSACTION,
    });
  });

  /** Only the licensed agent opens one. Creation grants no authority: parties are named, not confirmed. */
  orgRouter.post('/agent/transactions', (req, res) => {
    if (!access.resolveMembership(req, res)) return;
    if (!access.requireCap(req, res, 'transactions.write')) return;
    const b = inputOr400(res, 'create', req.body);
    if (!b) return;
    const key = clientKeyOr400(b, res);
    if (key === undefined) return;
    const { type } = b;
    const jurisdictions = [...new Set(b.jurisdictions.map((j) => j.toUpperCase()))];
    const rawParties = b.parties ?? [];
    const fp = payloadFingerprint({ type, jurisdictions, parties: rawParties });
    if (key) {
      const hit = txs.byCreateKey(req.org.id, req.orgUser.id, key);
      if (hit) {
        if (hit.keys.create.fp === fp)
          return res.json({ transaction: projectTransaction(hit, agentViewer(req)), idempotent: true });
        return sendTransactionError(
          res,
          {
            error: 'TRANSACTION_IDEMPOTENCY_CONFLICT',
            message: 'That idempotency key was used for a different request.',
          },
          'create',
        );
      }
    }
    if (limitedOr429(res, 'transaction_write', req.orgUser.id)) return;
    // An unverified licence does not open a transaction.
    const gate = compliance.facetGateProblem(req.orgUser.id, jurisdictions);
    if (gate)
      return sendTransactionError(
        res,
        {
          ...gate,
          message:
            gate.error === 'JURISDICTION_UNSUPPORTED'
              ? 'No encoded policy covers this jurisdiction. A transaction cannot be opened for it.'
              : `A regulated action needs a VERIFIED ${gate.facet}${gate.memberAssociation ? ` (${gate.memberAssociation})` : ''}; it is ${gate.state}.`,
        },
        'create',
      );
    const parties = [];
    for (const raw of rawParties) {
      const party = resolveParty(req, res, raw, { type });
      if (!party) return;
      if (parties.some((x) => x.partyRole === party.partyRole))
        return sendTransactionError(
          res,
          {
            error: 'TRANSACTION_PARTY_EXISTS',
            partyRole: party.partyRole,
            message: `A ${party.partyRole} party is already named.`,
          },
          'create',
        );
      parties.push(party);
    }

    // A reference only: nothing about the recruitment case is copied in.
    const caseRef = filled(b.recruitmentCaseId);
    const individualId = parties.find((p) => p.partyRole === 'individual')?.subjectId ?? null;
    if (individualId) {
      const dup = duplicateOf({
        individualId,
        type,
        engagingOrgId: parties.find((p) => p.partyRole === 'engaging_entity')?.subjectId ?? null,
        releasingOrgId: parties.find((p) => p.partyRole === 'releasing_entity')?.subjectId ?? null,
      });
      // A loan beside a transfer, or a second engaging club, is a separate transaction and is not refused.
      if (dup)
        return sendTransactionError(
          res,
          {
            error: 'TRANSACTION_DUPLICATE_CONTEXT',
            transactionId: dup.id,
            message:
              'A live transaction already covers this individual, this type and these clubs. Continue in that one, or end it first.',
          },
          'create',
        );
    }
    if (caseRef && !integration?.bindHandoff)
      return sendTransactionError(
        res,
        { error: 'HANDOFF_NOT_FOUND', message: 'A recruitment case cannot be referenced in this build.' },
        'create',
      );
    const at = now();
    const id = nextId('atx');
    inUnit(() => {
      // A cited case must have invited this agency. Bound in the same unit, so a citation that does not check out
      // creates no transaction at all.
      if (caseRef) {
        const problem = integration.bindHandoff({
          recruitmentCaseId: caseRef,
          transactionId: id,
          agencyOrgId: req.org.id,
          agentUserId: req.orgUser.id,
          clientId: individualId,
          at,
        });
        if (problem) {
          refuse(
            res,
            {
              error: problem,
              message:
                'No open invitation from that recruitment case is addressed to you. A club invites a workspace; citing a case you were not invited to does not open one.',
            },
            'create',
          );
        }
      }
      const ctx = compliance.openContext({
        agencyOrgId: req.org.id,
        agentUserId: req.orgUser.id,
        type,
        jurisdictions,
        transactionId: id,
        by: byAgent(req),
      });
      const tx = {
        id,
        agencyOrgId: req.org.id,
        agentUserId: req.orgUser.id,
        type,
        jurisdictions,
        status: 'DRAFT',
        parties,
        contextId: ctx.id,
        compliance: null,
        reEvaluationPending: false,
        notes: [],
        linkedThreads: [],
        links: { trialId: null, opportunityId: null, recruitmentCaseId: caseRef },
        terms: { versions: [] },
        holdReasonCode: null,
        holdReason: null,
        heldAt: null,
        cancelReasonCode: null,
        cancelledAt: null,
        closeReasonCode: null,
        closedAt: null,
        archivedAt: null,
        initiatedBy: byAgent(req),
        createdAt: at,
        updatedAt: at,
        keys: key ? { create: { key, fp } } : {},
        rev: 1,
        revAt: at,
        revBy: null,
        history: [entry('transaction_created', byAgent(req), { count: parties.length })],
      };
      txs.create(tx);
      recheckCompliance(id, byAgent(req));
      broadcast('agent_transaction_created', { orgId: req.org.id, txId: id });
      for (const p of parties)
        notifyParty(
          tx,
          p,
          'agent_transaction_action',
          `A transaction workspace has been opened naming you as the ${p.partyRole.replace(/_/g, ' ')}. Confirm your participation to let it proceed. Confirming does not agree to any terms.`,
        );
      const stored = txById(id);
      return () => res.status(201).json({ transaction: projectTransaction(stored, agentViewer(req)) });
    });
  });

  orgRouter.get('/agent/transactions/:id', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id);
    if (!tx) return;
    res.json({ transaction: projectTransaction(tx, agentViewer(req)) });
  });

  orgRouter.post('/agent/transactions/:id/parties', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true });
    if (!tx) return;
    if (!writableOr(res, tx, 'parties')) return;
    if (limitedOr429(res, 'transaction_write', req.orgUser.id)) return;
    const b = inputOr400(res, 'party', req.body);
    if (!b) return;
    const key = clientKeyOr400(b, res);
    if (key === undefined) return;
    const party = resolveParty(req, res, b, { type: tx.type });
    if (!party) return;
    const fp = payloadFingerprint({ partyRole: party.partyRole, subjectId: party.subjectId });
    if (key && tx.keys[`party:${key}`]) {
      if (tx.keys[`party:${key}`].fp === fp)
        return res.json({ transaction: projectTransaction(tx, agentViewer(req)), idempotent: true });
      return sendTransactionError(res, { error: 'TRANSACTION_IDEMPOTENCY_CONFLICT' }, 'parties');
    }
    if (partiesOf(tx).some((x) => !x.removed && x.partyRole === party.partyRole))
      return sendTransactionError(res, { error: 'TRANSACTION_PARTY_EXISTS', partyRole: party.partyRole }, 'parties');
    if (partiesOf(tx).length >= TRANSACTION_LIMITS.parties * 3)
      return sendTransactionError(
        res,
        {
          error: 'TRANSACTION_INPUT_INVALID',
          field: 'parties',
          message: 'This transaction already holds the maximum number of party records.',
        },
        'parties',
      );
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      txs.addParty(
        tx.id,
        { party, key: key ? { key, fp } : null },
        txBook(byAgent(req), [
          entry('transaction_party_added', byAgent(req), {
            partyRole: party.partyRole,
            subjectKind: party.subjectKind,
          }),
        ]),
      );
      partyChanged(tx.id, byAgent(req));
      bumpTx(tx.id, byAgent(req));
      broadcast('agent_transaction_party_changed', { orgId: tx.agencyOrgId, txId: tx.id, partyRole: party.partyRole });
      notifyParty(
        tx,
        party,
        'agent_transaction_action',
        `A transaction workspace now names you as the ${party.partyRole.replace(/_/g, ' ')}. Confirm your participation to let it proceed. Confirming does not agree to any terms.`,
      );
      const stored = txById(tx.id);
      return () => res.status(201).json({ transaction: projectTransaction(stored, agentViewer(req)) });
    });
  });

  /** The party row stays with its `removedAt`; every representation naming that role is withdrawn. */
  orgRouter.post('/agent/transactions/:id/parties/:pid/remove', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true });
    if (!tx) return;
    if (!writableOr(res, tx, 'parties')) return;
    const party = partiesOf(tx).find((p) => p && p.id === req.params.pid);
    if (!party) return sendTransactionError(res, { error: 'TRANSACTION_PARTY_NOT_FOUND' }, 'parties');
    if (!inputOr400(res, 'rev', req.body)) return;
    if (party.removed) return res.json({ transaction: projectTransaction(tx, agentViewer(req)), idempotent: true });
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      for (const r of repsOf(tx.id)) {
        if (r.partyRole !== party.partyRole || r.status === 'withdrawn') continue;
        repsRepo.withdraw(
          r.id,
          { at: now(), reason: 'party_removed' },
          rowBook(
            byAgent(req),
            [
              entry('transaction_representation_withdrawn', byAgent(req), {
                partyRole: r.partyRole,
                status: 'withdrawn',
              }),
            ],
            { userId: req.orgUser.id, name: req.orgUser.name },
          ),
        );
      }
      txs.removeParty(
        tx.id,
        { partyId: party.id, at: now() },
        txBook(byAgent(req), [
          entry('transaction_party_removed', byAgent(req), {
            partyRole: party.partyRole,
            subjectKind: party.subjectKind,
          }),
        ]),
      );
      partyChanged(tx.id, byAgent(req));
      bumpTx(tx.id, byAgent(req));
      broadcast('agent_transaction_party_changed', { orgId: tx.agencyOrgId, txId: tx.id, partyRole: party.partyRole });
      const stored = txById(tx.id);
      return () => res.json({ transaction: projectTransaction(stored, agentViewer(req)) });
    });
  });

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

  /**
   * An agreement active for this player is not by itself authority here: its scope must cover this type and every
   * jurisdiction, and the conflict engine must answer with this binding included.
   */
  orgRouter.post('/agent/transactions/:id/representations', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true });
    if (!tx) return;
    if (!writableOr(res, tx, 'representations')) return;
    const b = inputOr400(res, 'representation', req.body);
    if (!b) return;
    const key = clientKeyOr400(b, res);
    if (key === undefined) return;
    const partyRole = b.partyRole;
    const party = partiesOf(tx).find((p) => !p.removed && p.partyRole === partyRole);
    if (!party) return sendTransactionError(res, { error: 'TRANSACTION_PARTY_NOT_FOUND' }, 'representations');
    const fp = payloadFingerprint({ partyRole, agreementId: b.agreementId ?? null });
    if (key) {
      const hit = repsRepo.byAttachKey(tx.id, key);
      if (hit) {
        if (hit.keys.attach.fp === fp)
          return res.json({ transaction: projectTransaction(tx, agentViewer(req)), idempotent: true });
        return sendTransactionError(res, { error: 'TRANSACTION_IDEMPOTENCY_CONFLICT' }, 'representations');
      }
    }
    if (limitedOr429(res, 'transaction_write', req.orgUser.id)) return;
    if (liveRepsOf(tx.id).some((r) => r.partyRole === partyRole && r.agentUserId === req.orgUser.id)) {
      return sendTransactionError(
        res,
        {
          error: 'TRANSACTION_PARTY_EXISTS',
          partyRole,
          message: 'You already represent this party in this transaction.',
        },
        'representations',
      );
    }
    // Safeguarding before scope, so a blocked party reads the same as an unknown one.
    let agreement = null;
    let declaredOnly = false;
    let scope = [];
    let jurisdictions = [];
    if (party.subjectKind === 'player') {
      const pl = findPlayer(party.subjectId);
      if (!pl || !isAdult(pl) || !orgCanSee(req.org, pl) || isBlocked(pl.id, req.org.id))
        return sendTransactionError(res, { error: 'TRANSACTION_PARTY_NOT_FOUND' }, 'representations');
      const named = b.agreementId ? rawCtx.agentReads.agreements.byId(b.agreementId) : null;
      agreement =
        named &&
        named.agentUserId === req.orgUser.id &&
        named.agencyOrgId === req.org.id &&
        named.clientId === party.subjectId
          ? named
          : null;
      if (!agreement)
        return sendTransactionError(
          res,
          {
            error: 'REPRESENTATION_REQUIRED',
            message: 'A client-confirmed, active relationship with this party is required (agreementId).',
          },
          'representations',
        );
      const st = effectiveAgreementStatus(agreement, now());
      const problem = compliance.representationScopeProblem({
        agreement,
        effectiveStatus: st,
        confirmed: agreement.confirmedAt != null && agreementGrantsAccess(agreement, req.orgUser.id, now()),
        contextType: tx.type,
        memberAssociations: tx.jurisdictions,
      });
      if (problem)
        return sendTransactionError(
          res,
          {
            ...problem,
            message:
              problem.error === 'REPRESENTATION_SCOPE_INSUFFICIENT'
                ? "The relationship does not cover this transaction's scope or jurisdiction."
                : 'No active, client-confirmed relationship covers this party.',
          },
          'representations',
        );
      scope = agreement.scope ?? [];
      jurisdictions = agreement.jurisdiction ? [agreement.jurisdiction] : [];
    } else {
      // An entity client has no ScoutBox agreement: declared only, pending attributed review.
      declaredOnly = true;
    }
    const gate = compliance.facetGateProblem(req.orgUser.id, tx.jurisdictions);
    if (gate)
      return sendTransactionError(
        res,
        {
          ...gate,
          message:
            gate.error === 'JURISDICTION_UNSUPPORTED'
              ? 'No encoded policy covers this jurisdiction.'
              : `A regulated action needs a VERIFIED ${gate.facet}${gate.memberAssociation ? ` (${gate.memberAssociation})` : ''}; it is ${gate.state}.`,
        },
        'representations',
      );
    inUnit(() => {
      // A refusal records no binding, but the evaluation and the snapshot naming it commit.
      const ctx = compliance.contextById(tx.contextId);
      const live = liveRepsOf(tx.id);
      compliance.project(ctx, { parties: partiesOf(tx), representations: live });
      const proposed = {
        agentUserId: req.orgUser.id,
        partyRole,
        agreementId: agreement?.id ?? null,
        declaredOnly,
        status: declaredOnly ? 'declared' : 'verified',
        firstActAt: now(),
      };
      const result = compliance.evaluate(ctx, byAgent(req), { proposed });
      const snapshotAndRefuse = (state, out) => {
        applyComplianceSnapshot(txById(tx.id), { state, result, ctx, by: byAgent(req) });
        bumpTx(tx.id, byAgent(req));
        return () => sendTransactionError(res, out, 'representations');
      };
      if (result.outcome === 'PROHIBITED_CONFLICT') {
        return snapshotAndRefuse(
          complianceStateFrom({
            outcome: result.outcome,
            reasons: result.reasons,
            representationCount: live.length,
            partiesConfirmed: partiesConfirmed(tx),
          }),
          {
            error: 'REPRESENTATION_CONFLICT',
            reasons: result.reasons.filter((r) =>
              ['PROHIBITED_COMBINATION', 'COMBINATION_NOT_PERMITTED', 'CONNECTED_AGENT_ATTRIBUTION'].includes(r.code),
            ),
            policyVersions: result.policyVersions,
            outcome: result.outcome,
            message: 'An encoded ACTIVE rule prohibits this combination of parties. Nothing was recorded.',
          },
        );
      }
      if (result.outcome === 'PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED') {
        return snapshotAndRefuse(
          complianceStateFrom({
            outcome: result.outcome,
            reasons: result.reasons,
            consentsOutstanding: result.consentsOutstanding,
            representationCount: live.length,
            partiesConfirmed: partiesConfirmed(tx),
          }),
          {
            error: 'CONSENT_REQUIRED',
            consentsOutstanding: result.consentsOutstanding,
            reasons: result.reasons.filter((r) => r.code === 'CONSENT_REQUIRED'),
            policyVersions: result.policyVersions,
            outcome: result.outcome,
            contextId: ctx.id,
            message: 'Prior, party-specific written consent is outstanding. Request it; nothing was recorded.',
          },
        );
      }
      // A stale rev rolls the evaluation back with the rest.
      guardRevOrRollback(req, res, tx, TX_CONFLICT(tx));
      const needsReview =
        result.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED' || result.outcome === 'INSUFFICIENT_DATA';
      const reviewReasons = result.reasons.filter((r) => r.code !== 'FACET_VERIFIED');
      const snapshot = { outcome: result.outcome, evaluationId: result.evaluationId, evaluatedAt: result.evaluatedAt };
      if (needsReview && !declaredOnly) {
        // A review item instead of the binding.
        const review = compliance.createReview({
          kind: 'conflict_evaluation',
          agencyOrgId: tx.agencyOrgId,
          agentUserId: req.orgUser.id,
          subject: { contextId: ctx.id, transactionId: tx.id, partyRole },
          reasons: reviewReasons,
          policyVersions: result.policyVersions,
          snapshot,
          requestedBy: byAgent(req),
        });
        return snapshotAndRefuse(
          complianceStateFrom({
            outcome: result.outcome,
            reasons: result.reasons,
            representationCount: live.length,
            partiesConfirmed: partiesConfirmed(tx),
          }),
          {
            error: 'REGULATORY_REVIEW_REQUIRED',
            reasons: review.reasons,
            policyVersions: result.policyVersions,
            outcome: result.outcome,
            contextId: ctx.id,
            message:
              "The deciding rule's operative status is uncertain or not encoded. An attributed review item was created; nothing proceeds until it is resolved under a named policy version.",
          },
        );
      }
      const repId = nextId('txr');
      let reviewId = null;
      if (declaredOnly) {
        reviewId = compliance.createReview({
          kind: 'representation_declared',
          agencyOrgId: tx.agencyOrgId,
          agentUserId: req.orgUser.id,
          subject: { contextId: ctx.id, transactionId: tx.id, representationId: repId, partyRole },
          reasons: reviewReasons,
          policyVersions: result.policyVersions,
          snapshot,
          requestedBy: byAgent(req),
        }).id;
      }
      const status = declaredOnly ? 'pending_review' : 'verified';
      const rep = {
        id: repId,
        transactionId: tx.id,
        agencyOrgId: tx.agencyOrgId,
        agentUserId: req.orgUser.id,
        partyRole,
        agreementId: agreement?.id ?? null,
        declaredOnly,
        scope,
        jurisdictions,
        status,
        reviewId,
        createdAt: now(),
        verifiedAt: declaredOnly ? null : now(),
        verifiedByReviewId: null,
        firstActAt: declaredOnly ? null : now(),
        withdrawnAt: null,
        withdrawnReason: null,
        keys: key ? { attach: { key, fp } } : {},
        rev: 1,
        revAt: now(),
        revBy: null,
        history: [
          entry('transaction_representation_attached', byAgent(req), {
            partyRole,
            status,
            policyVersions: result.policyVersions,
          }),
        ],
      };
      repsRepo.create(rep);
      txs.recordAct(
        tx.id,
        txBook(byAgent(req), [entry('transaction_representation_attached', byAgent(req), { partyRole, status })]),
      );
      recheckCompliance(tx.id, byAgent(req));
      bumpTx(tx.id, byAgent(req));
      // Recorded but not effective until reviewed: 422 rather than 201, which would read as "now in force".
      if (declaredOnly) {
        return () =>
          sendTransactionError(
            res,
            {
              error: 'REGULATORY_REVIEW_REQUIRED',
              reasons: reviewReasons,
              policyVersions: result.policyVersions,
              outcome: result.outcome,
              contextId: ctx.id,
              partyRole,
              message:
                'Representation of an entity with no ScoutBox agreement is recorded as declared and needs attributed review. It is not effective until a named reviewer confirms it.',
            },
            'representations',
          );
      }
      const stored = txById(tx.id);
      return () =>
        res.status(201).json({
          transaction: projectTransaction(stored, agentViewer(req)),
          representation: { id: rep.id, partyRole, status: rep.status },
        });
    });
  });

  orgRouter.post('/agent/transactions/:id/representations/:rid/withdraw', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true });
    if (!tx) return;
    if (!writableOr(res, tx, 'representations')) return;
    const rep = repsOf(tx.id).find((r) => r.id === req.params.rid && r.agentUserId === req.orgUser.id);
    if (!rep) return notFound(res, 'representations');
    if (!inputOr400(res, 'rev', req.body)) return;
    if (rep.status === 'withdrawn')
      return res.json({ transaction: projectTransaction(tx, agentViewer(req)), idempotent: true });
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      repsRepo.withdraw(
        rep.id,
        { at: now(), reason: 'agent_withdrew' },
        rowBook(byAgent(req), [
          entry('transaction_representation_withdrawn', byAgent(req), { partyRole: rep.partyRole }),
        ]),
      );
      txs.recordAct(
        tx.id,
        txBook(byAgent(req), [
          entry('transaction_representation_withdrawn', byAgent(req), { partyRole: rep.partyRole }),
        ]),
      );
      recheckCompliance(tx.id, byAgent(req));
      bumpTx(tx.id, byAgent(req));
      const stored = txById(tx.id);
      return () => res.json({ transaction: projectTransaction(stored, agentViewer(req)) });
    });
  });

  orgRouter.post('/agent/transactions/:id/evaluate', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true });
    if (!tx) return;
    if (!writableOr(res, tx, 'evaluate')) return;
    if (!inputOr400(res, 'evaluation', req.body)) return;
    if (limitedOr429(res, 'transaction_write', req.orgUser.id)) return;
    inUnit(() => {
      recheckCompliance(tx.id, byAgent(req));
      bumpTx(tx.id, byAgent(req));
      const stored = txById(tx.id);
      return () => res.json({ transaction: projectTransaction(stored, agentViewer(req)) });
    });
  });

  /** A move to ACTIVE needs a snapshot that is clear and current, recomputed in this request. */
  orgRouter.post('/agent/transactions/:id/status', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true });
    if (!tx) return;
    const b = inputOr400(res, 'status', req.body);
    if (!b) return;
    const { to } = b;
    if (tx.status === 'ARCHIVED')
      return sendTransactionError(
        res,
        { error: 'TRANSACTION_ARCHIVED', status: tx.status, message: 'An archived transaction is read-only.' },
        'status',
      );
    const guard = safeguardingProblem(tx);
    // Archiving stays possible: shelving a record nobody can act on is the safe move.
    if (guard && to !== 'ARCHIVED')
      return sendTransactionError(
        res,
        {
          error: 'TRANSACTION_PARTY_UNAVAILABLE',
          message:
            'A party to this transaction is no longer available to your organisation. It can be archived; it cannot be progressed.',
        },
        'status',
      );
    const key = clientKeyOr400(b, res);
    if (key === undefined) return;
    const reasonCode = text(b.reasonCode);
    const reason = text(b.reason);
    const fp = payloadFingerprint({ to, reasonCode, reason });
    // Before the transition check: a replay must answer "already done", not "not allowed from here".
    if (key && tx.keys[`status:${key}`]) {
      if (tx.keys[`status:${key}`].fp === fp)
        return res.json({ transaction: projectTransaction(tx, agentViewer(req)), idempotent: true });
      return sendTransactionError(res, { error: 'TRANSACTION_IDEMPOTENCY_CONFLICT' }, 'status');
    }
    if (!actorTransitionAllowed(tx.status, to))
      return sendTransactionError(
        res,
        {
          error: 'TRANSACTION_TRANSITION_NOT_ALLOWED',
          from: tx.status,
          to,
          allowed: ACTOR_TRANSITIONS[tx.status] ?? [],
          message: 'That is not a transition this transaction can make from its current state.',
        },
        'status',
      );
    if (limitedOr429(res, 'transaction_status_write', req.orgUser.id)) return;
    if (to === 'PARTIES_CONFIRMED') {
      if (!partiesConfirmed(tx))
        return sendTransactionError(
          res,
          {
            error: 'TRANSACTION_PARTIES_NOT_CONFIRMED',
            awaiting: partiesAwaitingConfirmation(tx),
            message:
              'Every required party must confirm its own participation first. Naming a party is not confirming it.',
          },
          'status',
        );
    }
    // A hold, cancellation or closure needs a code of its own kind; any other move takes none.
    const codes = REASON_CODES_FOR[to] ?? null;
    if (codes ? !codes.includes(reasonCode) : reasonCode !== '')
      return sendTransactionError(
        res,
        {
          error: 'TRANSACTION_INPUT_INVALID',
          field: 'reasonCode',
          allowed: codes ?? [],
          ...(codes ? {} : { message: `A move to ${to} takes no reason code.` }),
        },
        'status',
      );
    inUnit(() => {
      if (to === 'ACTIVE') {
        // Refused before the re-check, so the caller cannot enter the live workflow on facts they have not seen:
        // they must re-evaluate and read the answer first. The flag commits with the refusal.
        const stale0 = stalenessOf(tx);
        if (stale0) {
          txs.flagStale(
            tx.id,
            {},
            txBook(byAgent(req), [entry('transaction_compliance_stale', byAgent(req), { staleness: stale0 })], {
              touch: true,
            }),
          );
          bumpTx(tx.id, byAgent(req));
          return () =>
            sendTransactionError(
              res,
              {
                error: 'TRANSACTION_COMPLIANCE_STALE',
                staleness: stale0,
                message:
                  'The recorded compliance evaluation no longer matches the current facts. Re-evaluate and read the new answer before progressing.',
              },
              'status',
            );
        }
        const { safeguarding, state, tx: after } = recheckCompliance(tx.id, byAgent(req));
        // A refusal below commits the re-evaluation and the rev it moved.
        if (!safeguarding && (state?.blocked || !state?.clear || !actorTransitionAllowed(after.status, to)))
          bumpTx(tx.id, byAgent(req));
        if (safeguarding) return () => notFound(res, 'status');
        if (state?.blocked)
          return () =>
            sendTransactionError(
              res,
              {
                error: 'TRANSACTION_COMPLIANCE_BLOCKED',
                outcome: state.outcome,
                reasons: state.reasonCodes.map((code) => ({ code })),
                message:
                  'An encoded ACTIVE rule prohibits this combination. A reviewer cannot approve past it; only changed facts or a new policy version can.',
              },
              'status',
            );
        if (!state?.clear)
          return () =>
            sendTransactionError(
              res,
              {
                error: 'TRANSACTION_COMPLIANCE_PENDING',
                pendingReason: state?.pendingReason ?? null,
                outcome: state?.outcome ?? null,
                reasons: (state?.reasonCodes ?? []).map((code) => ({ code })),
                message: 'This transaction cannot progress while compliance is outstanding.',
              },
              'status',
            );
        // The re-evaluation may have moved the status.
        if (!actorTransitionAllowed(after.status, to))
          return () =>
            sendTransactionError(
              res,
              {
                error: 'TRANSACTION_TRANSITION_NOT_ALLOWED',
                from: after.status,
                to,
                allowed: ACTOR_TRANSITIONS[after.status] ?? [],
              },
              'status',
            );
      }
      // A stale rev rolls back the re-evaluation above with the rest.
      guardRevOrRollback(req, res, tx, TX_CONFLICT(tx));
      const from = txById(tx.id).status;
      const action =
        to === 'ON_HOLD'
          ? 'transaction_held'
          : to === 'CANCELLED'
            ? 'transaction_cancelled'
            : to === 'CLOSED'
              ? 'transaction_closed'
              : to === 'ARCHIVED'
                ? 'transaction_archived'
                : 'transaction_status_changed';
      txs.moveByActor(
        tx.id,
        { to, at: now(), key: key ? { key, fp } : null, reasonCode: reasonCode || null, reason: reason || null },
        txBook(
          byAgent(req),
          [entry(action, byAgent(req), { from, to, ...(reasonCode ? { holdReasonCode: reasonCode } : {}) })],
          { touch: true },
        ),
      );
      bumpTx(tx.id, byAgent(req));
      if (['CANCELLED', 'CLOSED'].includes(to)) {
        const ctx = compliance.contextById(tx.contextId);
        if (ctx) compliance.closeContext(ctx, byAgent(req));
      }
      // Literal event names, one call site each: the event registry audit reads broadcast call sites textually.
      const payload = { orgId: tx.agencyOrgId, txId: tx.id, status: to };
      if (to === 'ON_HOLD') broadcast('agent_transaction_held', payload);
      else if (to === 'CANCELLED') broadcast('agent_transaction_cancelled', payload);
      else if (to === 'CLOSED') broadcast('agent_transaction_closed', payload);
      else broadcast('agent_transaction_status_changed', payload);
      for (const p of partiesOf(tx).filter((x) => !x.removed)) {
        notifyParty(
          tx,
          p,
          'agent_transaction',
          `A transaction you are party to is now "${to.replace(/_/g, ' ').toLowerCase()}". Nothing has been agreed or signed.`,
        );
      }
      const stored = txById(tx.id);
      return () => res.json({ transaction: projectTransaction(stored, agentViewer(req)) });
    });
  });

  /** Delegates to the same function as the compliance ledger's own route. */
  orgRouter.post('/agent/transactions/:id/consents/request', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true });
    if (!tx) return;
    if (!writableOr(res, tx, 'consents')) return;
    const ctx = compliance.contextById(tx.contextId);
    if (!ctx) return notFound(res, 'consents');
    // The projection is rebuilt from the transaction's own rows, so it is its own write, outside the consent route's
    // unit, and costs nothing if committed alone.
    apartFromTheAct("the compliance engine's input is re-projected from the transaction", () =>
      compliance.project(ctx, { parties: partiesOf(tx), representations: liveRepsOf(tx.id) }),
    );
    compliance.requestConsent(req, res, ctx);
  });

  /**
   * Terms are recorded as data, not validated: validating a suspended fee rule would be wrong, and proposing terms
   * would make ScoutBox the negotiator.
   */
  orgRouter.post('/agent/transactions/:id/terms', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true });
    if (!tx) return;
    if (!writableOr(res, tx, 'terms')) return;
    if (limitedOr429(res, 'transaction_write', req.orgUser.id)) return;
    const b = inputOr400(res, 'terms', req.body);
    if (!b) return;
    const summary = text(b.summary);
    if (!summary)
      return sendTransactionError(
        res,
        {
          error: 'TERMS_INPUT_INVALID',
          field: 'summary',
          problem: 'required',
          message: 'A terms version needs a written summary of what the parties recorded.',
        },
        'terms',
      );
    const roles = roomRolesFor(tx, agentViewer(req));
    const visibility = b.visibility ?? '';
    if (!uploadableVisibilities(roles).includes(visibility))
      return sendTransactionError(
        res,
        {
          error: 'DOCUMENT_VISIBILITY_NOT_PERMITTED',
          visibility: visibility || null,
          allowed: uploadableVisibilities(roles),
        },
        'terms',
      );
    if (tx.terms.versions.length >= TRANSACTION_LIMITS.termsVersions)
      return sendTransactionError(
        res,
        {
          error: 'TERMS_INPUT_INVALID',
          field: 'summary',
          message: 'This transaction already holds the maximum number of recorded terms versions.',
        },
        'terms',
      );
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      const version = txById(tx.id).terms.versions.length + 1;
      const terms = {
        id: nextId('txt'),
        at: now(),
        by: byAgent(req),
        recordedFor: b.recordedFor,
        visibility,
        summary,
        version,
      };
      txs.recordTerms(
        tx.id,
        { terms },
        txBook(
          byAgent(req),
          [entry('transaction_terms_recorded', byAgent(req), { partyRole: b.recordedFor, visibility, version })],
          { touch: true },
        ),
      );
      bumpTx(tx.id, byAgent(req));
      const stored = txById(tx.id);
      return () => res.status(201).json({ transaction: projectTransaction(stored, agentViewer(req)) });
    });
  });

  orgRouter.post('/agent/transactions/:id/links', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true });
    if (!tx) return;
    if (!writableOr(res, tx, 'links')) return;
    const b = inputOr400(res, 'opportunityLink', req.body);
    if (!b) return;
    const opp = scoutingReads.opportunities.byId(b.opportunityId.trim());
    // An unknown and an invisible opportunity answer alike.
    const engaging = partiesOf(tx).find((p) => !p.removed && p.partyRole === 'engaging_entity');
    if (!opp || !engaging || opp.orgId !== engaging.subjectId)
      return sendTransactionError(
        res,
        {
          error: 'TRANSACTION_INPUT_INVALID',
          field: 'opportunityId',
          message: 'No opportunity of the engaging club matches that reference.',
        },
        'links',
      );
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      txs.linkOpportunity(
        tx.id,
        { opportunityId: opp.id },
        txBook(byAgent(req), [entry('transaction_status_changed', byAgent(req), { from: tx.status, to: tx.status })], {
          touch: true,
        }),
      );
      bumpTx(tx.id, byAgent(req));
      const stored = txById(tx.id);
      return () => res.json({ transaction: projectTransaction(stored, agentViewer(req)) });
    });
  });

  // ============================================================ documents

  /** No bytes are stored here: `evidenceRef` points into the evidence vault, and without one a document is a placeholder. */
  function addDocument(req, res, tx, { roles, partyRole, owner, by, rateKey }) {
    if (!writableOr(res, tx, 'documents')) return;
    if (limitedOr429(res, 'transaction_document_write', rateKey)) return;
    const b = inputOr400(res, 'document', req.body);
    if (!b) return;
    const key = clientKeyOr400(b, res);
    if (key === undefined) return;
    const label = text(b.label);
    const { documentType } = b;
    const allowed = uploadableVisibilities(roles, partyRole);
    const visibility = b.visibility ?? '';
    if (!allowed.includes(visibility))
      return sendTransactionError(
        res,
        {
          error: 'DOCUMENT_VISIBILITY_NOT_PERMITTED',
          visibility: visibility || null,
          allowed,
          message:
            'You cannot file a document into a lane you do not sit in, and nobody may file into the Trust & Safety lane.',
        },
        'documents',
      );
    if (!label)
      return sendTransactionError(
        res,
        {
          error: 'DOCUMENT_INPUT_INVALID',
          field: 'label',
          problem: 'required',
          message: 'A document needs a label the other parties can read.',
        },
        'documents',
      );
    let evidenceRef = null;
    if (b.evidenceRef) {
      const ref = b.evidenceRef;
      const ev = rawCtx.verificationReads.evidence.byId(ref.id.trim());
      // The uploader must own the evidence; an unknown id and a foreign id answer alike.
      const mine =
        ev &&
        ((owner.kind === 'club' && ev.orgId === owner.id) ||
          (owner.kind === 'player' && ev.playerId === owner.id) ||
          (owner.kind === 'agent' && ev.orgId === tx.agencyOrgId));
      if (!ev || !mine)
        return sendTransactionError(
          res,
          {
            error: 'DOCUMENT_INPUT_INVALID',
            field: 'evidenceRef',
            message: 'No evidence record of yours matches that reference.',
          },
          'documents',
        );
      evidenceRef = { kind: 'verification_evidence', id: ev.id };
    }
    // A calendar day is valid through that day.
    const expiresAt = isAbsent(b.expiresAt) ? null : parseDateOrInstant(b.expiresAt, { dayEdge: 'end' }).ms;
    if (expiresAt !== null && expiresAt <= now())
      return sendTransactionError(
        res,
        { error: 'DOCUMENT_INPUT_INVALID', field: 'expiresAt', message: 'An expiry must be a future timestamp.' },
        'documents',
      );
    const fp = payloadFingerprint({ documentType, visibility, label, evidenceRef });
    if (key) {
      const hit = docsRepo.byAddKey(tx.id, key);
      if (hit) {
        if (hit.keys.add.fp === fp)
          return res.json({ document: documentView(hit, roles, partyRole), idempotent: true });
        return sendTransactionError(res, { error: 'TRANSACTION_IDEMPOTENCY_CONFLICT' }, 'documents');
      }
    }
    if (docsRepo.liveCount(tx.id) >= TRANSACTION_LIMITS.documents)
      return sendTransactionError(
        res,
        {
          error: 'DOCUMENT_INPUT_INVALID',
          field: 'documentType',
          message: 'This transaction already holds the maximum number of documents.',
        },
        'documents',
      );
    inUnit(() => {
      const d = {
        id: nextId('txd'),
        transactionId: tx.id,
        documentType,
        visibility,
        label,
        version: 1,
        owner,
        ownerPartyRole: partyRole,
        uploadedBy: by,
        createdAt: now(),
        expiresAt,
        evidenceRef,
        supersedes: null,
        supersededBy: null,
        removedAt: null,
        keys: key ? { add: { key, fp } } : {},
        rev: 1,
        revAt: now(),
        revBy: null,
        history: [entry('transaction_document_added', by, { documentType, visibility, version: 1 })],
      };
      const stored = docsRepo.create(d);
      txs.recordAct(
        tx.id,
        txBook(by, [entry('transaction_document_added', by, { documentType, visibility })], { touch: true }),
      );
      broadcast('agent_transaction_document_added', { orgId: tx.agencyOrgId, txId: tx.id, docId: d.id });
      // A notification is a disclosure: only parties the visibility class admits hear of it.
      if (visibility !== 'AGENT_PRIVATE') {
        for (const p of partiesOf(tx).filter((x) => !x.removed)) {
          const otherRoles = p.subjectKind === 'player' ? ['party_individual'] : ['party_club_signatory'];
          if (!canSeeVisibility(visibility, otherRoles, p.partyRole)) continue;
          if (p.subjectKind === 'player' && owner.kind === 'player' && p.subjectId === owner.id) continue;
          if (p.subjectKind === 'club' && owner.kind === 'club' && p.subjectId === owner.id) continue;
          notifyParty(
            tx,
            p,
            'agent_transaction',
            `A document has been shared in a transaction you are party to: ${label}.`,
          );
        }
        if (owner.kind !== 'agent')
          notify(
            { kind: 'org_user', id: tx.agentUserId },
            'agent_transaction',
            `A party shared a document in a transaction: ${label}.`,
            tx.id,
          );
      }
      return () => res.status(201).json({ document: documentView(stored, roles, partyRole) });
    });
  }

  /** Reauthorised every time: a reference is never a standing permission. */
  function readDocumentReference(req, res, tx, { roles, partyRole }) {
    const d = docsOf(tx.id).find((x) => x.id === req.params.docId);
    if (!d || !canSeeVisibility(d.visibility, roles, partyRole))
      return sendTransactionError(
        res,
        { error: 'DOCUMENT_NOT_FOUND', message: 'No document with that reference is available to you.' },
        'documents',
      );
    if (isExpiredAt(d.expiresAt, now()))
      return sendTransactionError(
        res,
        { error: 'DOCUMENT_NOT_FOUND', message: 'No document with that reference is available to you.' },
        'documents',
      );
    if (!d.evidenceRef)
      return res.json({
        document: documentView(d, roles, partyRole),
        reference: null,
        note: 'This document is a placeholder: no file has been attached to it in the evidence vault.',
      });
    res.json({
      document: documentView(d, roles, partyRole),
      reference: d.evidenceRef,
      note: 'Fetch the file through the canonical evidence route, which authorises the download itself. Holding this reference is not authority to read the file.',
    });
  }

  orgRouter.get('/agent/transactions/:id/documents', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id);
    if (!tx) return;
    const roles = roomRolesFor(tx, agentViewer(req));
    res.json({
      items: docsOf(tx.id)
        .filter((d) => canSeeVisibility(d.visibility, roles))
        .map((d) => documentView(d, roles)),
      documentTypes: DOCUMENT_TYPES,
      uploadable: uploadableVisibilities(roles),
    });
  });
  orgRouter.post('/agent/transactions/:id/documents', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true });
    if (!tx) return;
    addDocument(req, res, tx, {
      roles: roomRolesFor(tx, agentViewer(req)),
      partyRole: null,
      owner: { kind: 'agent', id: req.orgUser.id },
      by: byAgent(req),
      rateKey: req.orgUser.id,
    });
  });
  orgRouter.get('/agent/transactions/:id/documents/:docId/reference', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id);
    if (!tx) return;
    readDocumentReference(req, res, tx, { roles: roomRolesFor(tx, agentViewer(req)), partyRole: null });
  });
  /** The old row is kept, untouched but for its link. */
  orgRouter.post('/agent/transactions/:id/documents/:docId/supersede', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true });
    if (!tx) return;
    if (!writableOr(res, tx, 'documents')) return;
    const old = docsOf(tx.id).find((x) => x.id === req.params.docId);
    const roles = roomRolesFor(tx, agentViewer(req));
    if (!old || old.owner?.kind !== 'agent' || !canSeeVisibility(old.visibility, roles))
      return sendTransactionError(res, { error: 'DOCUMENT_NOT_FOUND' }, 'documents');
    if (old.supersededBy)
      return sendTransactionError(
        res,
        { error: 'DOCUMENT_SUPERSEDED', message: 'That version has already been superseded.' },
        'documents',
      );
    const b = inputOr400(res, 'supersession', req.body);
    if (!b) return;
    const label = text(b.label) || old.label;
    if (!guardRev(req, res, old, { errorCode: 'DOCUMENT_VERSION_CONFLICT', current: { version: old.version } })) return;
    inUnit(() => {
      const d = {
        id: nextId('txd'),
        transactionId: tx.id,
        documentType: old.documentType,
        visibility: old.visibility,
        label,
        version: old.version + 1,
        owner: old.owner,
        ownerPartyRole: old.ownerPartyRole,
        uploadedBy: byAgent(req),
        createdAt: now(),
        expiresAt: old.expiresAt,
        evidenceRef: old.evidenceRef,
        supersedes: old.id,
        supersededBy: null,
        removedAt: null,
        keys: {},
        rev: 1,
        revAt: now(),
        revBy: null,
        history: [
          entry('transaction_document_added', byAgent(req), {
            documentType: old.documentType,
            visibility: old.visibility,
            version: old.version + 1,
          }),
        ],
      };
      docsRepo.supersede(
        old.id,
        { document: d },
        rowBook(byAgent(req), [entry('transaction_document_superseded', byAgent(req), { version: old.version })]),
      );
      const stored = docsRepo.byId(d.id);
      txs.recordAct(
        tx.id,
        txBook(
          byAgent(req),
          [
            entry('transaction_document_superseded', byAgent(req), {
              documentType: d.documentType,
              version: d.version,
            }),
          ],
          { touch: true },
        ),
      );
      return () => res.status(201).json({ document: documentView(stored, roles) });
    });
  });

  // ============================================================ notes

  /** Notes use the documents' visibility classes: each names its lane and is absent for anyone the lane excludes. */
  function addNote(req, res, tx, { roles, partyRole, by, rateKey }) {
    if (!writableOr(res, tx, 'notes')) return;
    if (limitedOr429(res, 'transaction_note_write', rateKey)) return;
    const b = inputOr400(res, 'note', req.body);
    if (!b) return;
    const noteText = text(b.text);
    if (!noteText)
      return sendTransactionError(
        res,
        { error: 'NOTE_INPUT_INVALID', field: 'text', problem: 'required', message: 'A note needs text.' },
        'notes',
      );
    const visibility = b.visibility ?? '';
    const allowed = uploadableVisibilities(roles, partyRole).filter((v) => NOTE_VISIBILITY.includes(v));
    if (!allowed.includes(visibility))
      return sendTransactionError(
        res,
        { error: 'DOCUMENT_VISIBILITY_NOT_PERMITTED', visibility: visibility || null, allowed },
        'notes',
      );
    if (tx.notes.length >= TRANSACTION_LIMITS.notes)
      return sendTransactionError(
        res,
        {
          error: 'NOTE_INPUT_INVALID',
          field: 'text',
          message: 'This transaction already holds the maximum number of notes.',
        },
        'notes',
      );
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      const n = { id: nextId('txn'), visibility, text: noteText, by, at: now() };
      txs.addNote(
        tx.id,
        { note: n },
        txBook(by, [entry('transaction_note_added', by, { visibility })], { touch: true }),
      );
      bumpTx(tx.id, by);
      return () =>
        res
          .status(201)
          .json({ note: { id: n.id, visibility: n.visibility, text: n.text, at: n.at, actor: actorLabel(n.by) } });
    });
  }

  orgRouter.post('/agent/transactions/:id/notes', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id, { write: true });
    if (!tx) return;
    addNote(req, res, tx, {
      roles: roomRolesFor(tx, agentViewer(req)),
      partyRole: null,
      by: byAgent(req),
      rateKey: req.orgUser.id,
    });
  });

  // ============================================================ timeline

  orgRouter.get('/agent/transactions/:id/timeline', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id);
    if (!tx) return;
    const roles = roomRolesFor(tx, agentViewer(req));
    res.json({
      items: timelineFor(tx, roles),
      note: 'The timeline is what YOU may see of what happened. The platform audit holds more operational detail and is not this.',
    });
  });

  orgRouter.get('/agent/transactions/:id/messages', (req, res) => {
    const tx = ownTransaction(req, res, req.params.id);
    if (!tx) return;
    const viewer = agentViewer(req);
    res.json({
      items: tx.linkedThreads.map((t) => ({
        id: t.id,
        channelId: t.channelId,
        linkedAt: t.linkedAt,
        actor: actorLabel(t.linkedBy),
        readable: channelReadableBy(t.channelId, viewer),
      })),
      note: "Correspondence lives in the canonical ScoutBox Inbox. A link records that a conversation exists and who shared it; reading it still needs the Inbox's own authorisation, which transaction membership alone does not give. ScoutBox never negotiates and never replies for anyone.",
    });
  });

  // ============================================================ CLUB lane

  orgRouter.get('/transactions', (req, res) => {
    if (req.org.type !== 'club')
      return res.json({ items: [], nextCursor: null, note: 'Transaction party lanes are for club organisations.' });
    const q = inputOr400(res, 'clubList', req.query, 'query');
    if (!q) return;
    let pageReq;
    try {
      pageReq = readPage(q, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const viewer = clubViewer(req);
    // Paged: a club's list grows with every transaction it is named in.
    const { records, nextCursor } = pageItems(txs.clubPage({ orgId: req.org.id, ...pageReq }).rows, pageReq.limit);
    const batch = batchFor(records);
    res.json({
      items: records.map((t) => projectTransaction(t, viewer, batch)),
      nextCursor,
      signatory: viewer.signatory,
      statuses: TRANSACTION_STATUSES,
      documentTypes: DOCUMENT_TYPES,
      note: viewer.signatory
        ? null
        : "You can read the transactions this club is party to. Confirming the club's participation and answering a consent need a recorded club signatory.",
      honest: HONEST_TRANSACTION,
    });
  });
  orgRouter.get('/transactions/:id', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id);
    if (!tx) return;
    res.json({ transaction: projectTransaction(tx, clubViewer(req)), signatory: clubViewer(req).signatory });
  });
  /** Only a recorded signatory binds the club. */
  orgRouter.post('/transactions/:id/confirm', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id, { signatory: true });
    if (!tx) return;
    if (!writableOr(res, tx, 'confirm')) return;
    if (limitedOr429(res, 'transaction_status_write', req.orgUser.id)) return;
    const party = partiesOf(tx).find((p) => !p.removed && p.subjectKind === 'club' && p.subjectId === req.org.id);
    if (!party) return notFound(res, 'confirm');
    if (!inputOr400(res, 'rev', req.body)) return;
    if (party.confirmedAt) return res.json({ transaction: projectTransaction(tx, clubViewer(req)), idempotent: true });
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      txs.confirmParty(
        tx.id,
        { partyId: party.id, at: now(), by: byClubUser(req) },
        txBook(byClubUser(req), [
          entry('transaction_party_confirmed', byClubUser(req), { partyRole: party.partyRole, subjectKind: 'club' }),
        ]),
      );
      partyChanged(tx.id, byClubUser(req));
      bumpTx(tx.id, byClubUser(req));
      broadcast('agent_transaction_party_changed', { orgId: tx.agencyOrgId, txId: tx.id, partyRole: party.partyRole });
      notify(
        { kind: 'org_user', id: tx.agentUserId },
        'agent_transaction',
        `A club confirmed its participation as the ${party.partyRole.replace(/_/g, ' ')} in a transaction.`,
        tx.id,
      );
      const stored = txById(tx.id);
      return () => res.json({ transaction: projectTransaction(stored, clubViewer(req)) });
    });
  });
  orgRouter.get('/transactions/:id/documents', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id);
    if (!tx) return;
    const viewer = clubViewer(req);
    const roles = roomRolesFor(tx, viewer);
    const partyRole = req.txPartyRole;
    res.json({
      items: docsOf(tx.id)
        .filter((d) => canSeeVisibility(d.visibility, roles, partyRole) && !d.supersededBy)
        .map((d) => documentView(d, roles, partyRole)),
      uploadable: uploadableVisibilities(roles, partyRole),
      documentTypes: DOCUMENT_TYPES,
    });
  });
  orgRouter.post('/transactions/:id/documents', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id, { signatory: true });
    if (!tx) return;
    addDocument(req, res, tx, {
      roles: roomRolesFor(tx, clubViewer(req)),
      partyRole: req.txPartyRole,
      owner: { kind: 'club', id: req.org.id },
      by: byClubUser(req),
      rateKey: req.orgUser.id,
    });
  });
  orgRouter.get('/transactions/:id/documents/:docId/reference', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id);
    if (!tx) return;
    readDocumentReference(req, res, tx, { roles: roomRolesFor(tx, clubViewer(req)), partyRole: req.txPartyRole });
  });
  orgRouter.post('/transactions/:id/notes', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id);
    if (!tx) return;
    addNote(req, res, tx, {
      roles: roomRolesFor(tx, clubViewer(req)),
      partyRole: req.txPartyRole,
      by: byClubUser(req),
      rateKey: req.orgUser.id,
    });
  });
  orgRouter.get('/transactions/:id/timeline', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id);
    if (!tx) return;
    res.json({
      items: timelineFor(tx, roomRolesFor(tx, clubViewer(req)), req.txPartyRole),
      note: 'The timeline is what this club may see of what happened.',
    });
  });
  /** The linker must pass the channel's own authorisation; linking discloses only that a conversation exists. */
  orgRouter.post('/transactions/:id/messages/link', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id, { signatory: true });
    if (!tx) return;
    if (!writableOr(res, tx, 'messages')) return;
    const b = inputOr400(res, 'threadLink', req.body);
    if (!b) return;
    const found = channels.byId(b.channelId.trim());
    const ch = found && found.orgId === req.org.id ? found : null;
    const individual = partiesOf(tx).find((p) => !p.removed && p.partyRole === 'individual');
    if (!ch || !individual || ch.playerId !== individual.subjectId)
      return sendTransactionError(
        res,
        {
          error: 'MESSAGE_THREAD_NOT_FOUND',
          message: "No conversation of yours with this transaction's individual matches that reference.",
        },
        'messages',
      );
    if (tx.linkedThreads.some((t) => t.channelId === ch.id))
      return res.json({ transaction: projectTransaction(tx, clubViewer(req)), idempotent: true });
    if (tx.linkedThreads.length >= TRANSACTION_LIMITS.linkedThreads)
      return sendTransactionError(
        res,
        {
          error: 'TRANSACTION_INPUT_INVALID',
          field: 'channelId',
          message: 'This transaction already links the maximum number of conversations.',
        },
        'messages',
      );
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      const thread = { id: nextId('txm'), channelId: ch.id, linkedBy: byClubUser(req), linkedAt: now() };
      txs.linkThread(
        tx.id,
        { thread },
        txBook(
          byClubUser(req),
          [entry('transaction_message_linked', byClubUser(req), { count: tx.linkedThreads.length + 1 })],
          { touch: true },
        ),
      );
      bumpTx(tx.id, byClubUser(req));
      broadcast('agent_transaction_message_linked', { orgId: tx.agencyOrgId, txId: tx.id });
      const stored = txById(tx.id);
      return () => res.status(201).json({ transaction: projectTransaction(stored, clubViewer(req)) });
    });
  });
  /** A trial of this club for this individual, by reference: no assessment crosses. */
  orgRouter.post('/transactions/:id/links', (req, res) => {
    const tx = clubTransaction(req, res, req.params.id, { signatory: true });
    if (!tx) return;
    if (!writableOr(res, tx, 'links')) return;
    const b = inputOr400(res, 'trialLink', req.body);
    if (!b) return;
    const individual = partiesOf(tx).find((p) => !p.removed && p.partyRole === 'individual');
    const foundTrial = recruitmentReads.trials.byId(b.trialId.trim());
    const trial =
      foundTrial && foundTrial.orgId === req.org.id && individual && foundTrial.playerId === individual.subjectId
        ? foundTrial
        : null;
    if (!trial)
      return sendTransactionError(
        res,
        {
          error: 'TRANSACTION_INPUT_INVALID',
          field: 'trialId',
          message: "No trial of yours with this transaction's individual matches that reference.",
        },
        'links',
      );
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      txs.linkTrial(
        tx.id,
        { trialId: trial.id },
        txBook(
          byClubUser(req),
          [entry('transaction_status_changed', byClubUser(req), { from: tx.status, to: tx.status })],
          { touch: true },
        ),
      );
      bumpTx(tx.id, byClubUser(req));
      const stored = txById(tx.id);
      return () => res.json({ transaction: projectTransaction(stored, clubViewer(req)) });
    });
  });

  // ============================================================ PLAYER lane

  playerRouter.get('/transactions', (req, res) => {
    if (req.playerIsMinor)
      return res.json({
        items: [],
        minor: true,
        note: 'Agent transactions are not available for under-18 accounts in ScoutBox.',
      });
    const viewer = playerViewer(req);
    // A per-player list: not paged.
    const mine = txs.forPlayer(req.player.id);
    const batch = batchFor(mine);
    res.json({
      items: mine.map((t) => projectTransaction(t, viewer, batch)),
      statuses: TRANSACTION_STATUSES,
      honest: HONEST_TRANSACTION,
    });
  });
  playerRouter.get('/transactions/:id', (req, res) => {
    const tx = playerTransaction(req, res, req.params.id);
    if (!tx) return;
    res.json({ transaction: projectTransaction(tx, playerViewer(req)) });
  });
  /** Nobody confirms for the individual. */
  playerRouter.post('/transactions/:id/confirm', (req, res) => {
    const tx = playerTransaction(req, res, req.params.id);
    if (!tx) return;
    if (!writableOr(res, tx, 'confirm')) return;
    if (limitedOr429(res, 'transaction_status_write', req.player.id)) return;
    const party = partiesOf(tx).find((p) => !p.removed && p.subjectKind === 'player' && p.subjectId === req.player.id);
    if (!party) return notFound(res, 'confirm');
    if (!inputOr400(res, 'rev', req.body)) return;
    if (party.confirmedAt)
      return res.json({ transaction: projectTransaction(tx, playerViewer(req)), idempotent: true });
    if (!guardRev(req, res, tx, TX_CONFLICT(tx))) return;
    inUnit(() => {
      txs.confirmParty(
        tx.id,
        { partyId: party.id, at: now(), by: byPlayer(req) },
        txBook(byPlayer(req), [
          entry('transaction_party_confirmed', byPlayer(req), { partyRole: party.partyRole, subjectKind: 'player' }),
        ]),
      );
      partyChanged(tx.id, byPlayer(req));
      bumpTx(tx.id, byPlayer(req));
      broadcast('agent_transaction_party_changed', { orgId: tx.agencyOrgId, txId: tx.id, partyRole: party.partyRole });
      notify(
        { kind: 'org_user', id: tx.agentUserId },
        'agent_transaction',
        'Your client confirmed their participation in a transaction.',
        tx.id,
      );
      const stored = txById(tx.id);
      return () => res.json({ transaction: projectTransaction(stored, playerViewer(req)) });
    });
  });
  playerRouter.get('/transactions/:id/documents', (req, res) => {
    const tx = playerTransaction(req, res, req.params.id);
    if (!tx) return;
    const roles = roomRolesFor(tx, playerViewer(req));
    res.json({
      items: docsOf(tx.id)
        .filter((d) => canSeeVisibility(d.visibility, roles, 'individual') && !d.supersededBy)
        .map((d) => documentView(d, roles, 'individual')),
      uploadable: uploadableVisibilities(roles, 'individual'),
      documentTypes: DOCUMENT_TYPES,
    });
  });
  playerRouter.post('/transactions/:id/documents', (req, res) => {
    const tx = playerTransaction(req, res, req.params.id);
    if (!tx) return;
    addDocument(req, res, tx, {
      roles: roomRolesFor(tx, playerViewer(req)),
      partyRole: 'individual',
      owner: { kind: 'player', id: req.player.id },
      by: byPlayer(req),
      rateKey: req.player.id,
    });
  });
  playerRouter.get('/transactions/:id/documents/:docId/reference', (req, res) => {
    const tx = playerTransaction(req, res, req.params.id);
    if (!tx) return;
    readDocumentReference(req, res, tx, { roles: roomRolesFor(tx, playerViewer(req)), partyRole: 'individual' });
  });
  playerRouter.get('/transactions/:id/timeline', (req, res) => {
    const tx = playerTransaction(req, res, req.params.id);
    if (!tx) return;
    res.json({
      items: timelineFor(tx, roomRolesFor(tx, playerViewer(req)), 'individual'),
      note: 'The timeline is what you may see of what happened in this transaction.',
    });
  });

  // ============================================================ TRUST & SAFETY lane

  /** States, ids and party roles only: a reviewer checks the platform's rules were applied, not the parties' papers. */
  const tsView = (tx, batch = null) => {
    const reps = batch ? batch.reps(tx.id) : repsOf(tx.id);
    const view = complianceOf(tx);
    return {
      id: tx.id,
      type: tx.type,
      status: tx.status,
      jurisdictions: tx.jurisdictions,
      agencyOrgId: tx.agencyOrgId,
      agentUserId: tx.agentUserId,
      parties: partiesOf(tx).map((p) => ({
        partyRole: p.partyRole,
        subjectKind: p.subjectKind,
        removed: !!p.removed,
        confirmed: !!p.confirmedAt,
      })),
      representations: reps.map((r) => ({
        partyRole: r.partyRole,
        status: r.status,
        declaredOnly: !!r.declaredOnly,
        reviewId: r.reviewId ?? null,
      })),
      compliance: view
        ? {
            outcome: view.outcome,
            pendingReason: view.pendingReason,
            blocked: view.blocked,
            clear: view.clear,
            reasonCodes: view.reasonCodes,
            policyVersions: view.policyVersions,
            evaluatedAt: view.evaluatedAt,
            stale: stalenessOf(tx, { view, reps }),
          }
        : null,
      reviews: compliance.reviewsForContext(tx.contextId),
      documentCount: (batch ? batch.docs(tx.id) : docsOf(tx.id)).length,
      noteCount: tx.notes.length,
      linkedThreadCount: tx.linkedThreads.length,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
      rev: tx.rev,
    };
  };
  tsRouter.get('/transactions', (req, res) => {
    const q = inputOr400(res, 'list', req.query, 'query');
    if (!q) return;
    const status = q.status ?? null;
    let pageReq;
    try {
      pageReq = readPage(q, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const { records, nextCursor } = pageItems(txs.allPage({ status, ...pageReq }).rows, pageReq.limit);
    const batch = batchFor(records);
    res.json({
      items: records.map((t) => tsView(t, batch)),
      nextCursor,
      statuses: TRANSACTION_STATUSES,
      note: "States, ids and party roles only. Transaction documents, notes, messages and terms are the parties' and are not exposed here.",
    });
  });
  /** Durations and counts only; no agent or player is ranked. */
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
  // Registered before the `:id` route, or Express would read "metrics" as an id.
  tsRouter.get('/transactions/:id', (req, res) => {
    const tx = txById(req.params.id);
    if (!tx) return notFound(res, 'ts');
    res.json({
      transaction: tsView(tx),
      audit: auditRows({ transactionId: tx.id }).slice(0, TRANSACTION_LIMITS.historyPage),
    });
  });

  // ============================================================ the audit
  const auditRows = (filter) =>
    transactionAuditRows({ reads: agentTransactions.reads, snapshotOf: complianceOf }, filter);

  // ============================================================ lifecycle hooks

  /** The transaction keeps its ids, roles, states and times and loses the person: party row and labels are emptied. */
  function onPlayerDeleted(playerId, at = now()) {
    agentTransactions.forgetPlayer(playerId, at, () => ({
      id: nextId('aud'),
      at,
      action: 'transaction_subject_tombstoned',
      by: bySystem('account deletion'),
      detail: { partyRole: 'individual' },
    }));
  }

  /**
   * A reviewer decided a declared-only binding. An approval records no act by the agent: `firstActAt` stays null, so a
   * later party-specific consent still counts as given in advance.
   */
  function representationReviewed({ transactionId, representationId, outcome, by, reviewId }) {
    const tx = txById(transactionId);
    const rep = tx ? repsRepo.byId(representationId) : null;
    if (!tx || !rep || rep.transactionId !== transactionId || rep.status !== 'pending_review') return;
    const action =
      outcome === 'APPROVED' ? 'transaction_representation_attached' : 'transaction_representation_withdrawn';
    const book = rowBook(by, [
      entry(action, by, { partyRole: rep.partyRole, status: outcome === 'APPROVED' ? 'verified' : 'withdrawn' }),
    ]);
    const next =
      outcome === 'APPROVED'
        ? repsRepo.verifyByReview(rep.id, { at: now(), reviewId }, book)
        : repsRepo.withdraw(rep.id, { at: now(), reason: 'review_rejected' }, book);
    txs.recordAct(
      tx.id,
      txBook(by, [entry(action, by, { partyRole: next.partyRole, status: next.status })], { touch: true }),
    );
    if (LIVE_STATUSES.includes(tx.status)) recheckCompliance(tx.id, by);
  }

  /**
   * The seam the Offer domain reads. Null unless the asking club is the engaging entity and the transaction is linked
   * to exactly the Offer's case, so a club cannot probe for a transaction by id from an unrelated case.
   */
  function offerReadinessFor(transactionId, { orgId, caseId } = {}) {
    if (typeof transactionId !== 'string' || !transactionId || !orgId || !caseId) return null;
    const tx = txById(transactionId);
    if (!tx) return null;
    if (clubPartyRoleOf(tx, orgId) !== 'engaging_entity') return null;
    if (tx.links.recruitmentCaseId !== caseId) return null;
    const view = complianceOf(tx);
    const readiness = offerReadiness(tx, {
      complianceState: view?.state ?? null,
      staleness: stalenessOf(tx, { view }),
    });
    return { tx: { id: tx.id, status: tx.status, type: tx.type ?? null }, readiness };
  }

  return {
    onPlayerDeleted,
    agencyAuditRows: (org) => auditRows({ agencyOrgId: org.id }),
    transactionAuditRows: auditRows,
    offerReadinessFor,
  };
}
