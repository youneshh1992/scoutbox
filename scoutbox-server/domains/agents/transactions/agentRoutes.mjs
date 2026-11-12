/** The agent's lane: its transactions, their parties and the representations bound to them. */

import { guardRev } from '../../platform/concurrency.mjs';
import { readPage, sendPageError } from '../../platform/paging.mjs';
import { payloadFingerprint } from '../../platform/idempotency.mjs';
import { filled } from '../../platform/schemas.mjs';
import { effectiveAgreementStatus, agreementGrantsAccess } from '../core/shared.mjs';
import { sendTransactionError, notFound } from './errors.mjs';
import {
  partiesOf,
  TRANSACTION_TYPES,
  TRANSACTION_STATUSES,
  PARTY_ROLES,
  ROOM_ROLES,
  ALL_TRANSITIONS,
  DOCUMENT_TYPES,
  DOCUMENT_VISIBILITY,
  complianceStateFrom,
  partiesConfirmed,
  HOLD_REASON_CODES,
  CANCEL_REASON_CODES,
  CLOSE_REASON_CODES,
  TRANSACTION_LIMITS,
  PENDING_REASONS,
} from './transaction.mjs';
import { now } from '../../platform/clock.mjs';
import { HONEST_TRANSACTION } from './shared.mjs';

export function registerAgentRoutes(ctx) {
  const {
    access,
    agentReads,
    agentViewer,
    applyComplianceSnapshot,
    batchFor,
    broadcast,
    bumpTx,
    byAgent,
    clientKeyOr400,
    compliance,
    duplicateOf,
    entry,
    findPlayer,
    guardRevOrRollback,
    inputOr400,
    integration,
    inUnit,
    isAdult,
    isBlocked,
    limitedOr429,
    liveRepsOf,
    nextId,
    notifyParty,
    orgCanSee,
    orgRouter,
    ownTransaction,
    pageItems,
    partyChanged,
    projectTransaction,
    recheckCompliance,
    refuse,
    repsOf,
    repsRepo,
    resolveParty,
    rowBook,
    TX_CONFLICT,
    txBook,
    txById,
    txs,
    writableOr,
  } = ctx;
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
      const named = b.agreementId ? agentReads.agreements.byId(b.agreementId) : null;
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
}
