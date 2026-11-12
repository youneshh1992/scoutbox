/** The agent's moves on a transaction: its status, the consents it needs, its terms and its links. */

import { apartFromTheAct } from '../../../writeRules.mjs';
import { guardRev } from '../../platform/concurrency.mjs';
import { payloadFingerprint } from '../../platform/idempotency.mjs';
import { sendTransactionError, notFound } from './errors.mjs';
import {
  partiesOf,
  ACTOR_TRANSITIONS,
  actorTransitionAllowed,
  uploadableVisibilities,
  partiesConfirmed,
  partiesAwaitingConfirmation,
  roomRolesFor,
  HOLD_REASON_CODES,
  CANCEL_REASON_CODES,
  CLOSE_REASON_CODES,
  TRANSACTION_LIMITS,
} from './transaction.mjs';
import { now } from '../../platform/clock.mjs';

const REASON_CODES_FOR = Object.freeze({
  ON_HOLD: HOLD_REASON_CODES,
  CANCELLED: CANCEL_REASON_CODES,
  CLOSED: CLOSE_REASON_CODES,
});

export function registerAgentWorkflowRoutes(ctx) {
  const {
    agentViewer,
    broadcast,
    bumpTx,
    byAgent,
    clientKeyOr400,
    compliance,
    entry,
    guardRevOrRollback,
    inputOr400,
    inUnit,
    limitedOr429,
    liveRepsOf,
    nextId,
    notifyParty,
    orgRouter,
    ownTransaction,
    projectTransaction,
    recheckCompliance,
    safeguardingProblem,
    scoutingReads,
    stalenessOf,
    text,
    TX_CONFLICT,
    txBook,
    txById,
    txs,
    writableOr,
  } = ctx;
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
}
