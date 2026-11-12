/** The Trust & Safety lane: read-only, states, ids and party roles. */

import { readPage, sendPageError } from '../../platform/paging.mjs';
import { notFound } from './errors.mjs';
import {
  partiesOf,
  TRANSACTION_TYPES,
  TRANSACTION_STATUSES,
  HOLD_REASON_CODES,
  CANCEL_REASON_CODES,
  TRANSACTION_LIMITS,
} from './transaction.mjs';

export function registerTsRoutes(ctx) {
  const {
    auditRows,
    batchFor,
    compliance,
    complianceOf,
    docsOf,
    inputOr400,
    pageItems,
    repsOf,
    stalenessOf,
    tsRouter,
    txById,
    txs,
  } = ctx;
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
}
