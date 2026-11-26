import { refuseWhenLimited } from '../../platform/rateLimit.mjs';
import { normaliseClientKey } from '../../platform/idempotency.mjs';
import { parseInput, filled } from '../../platform/schemas.mjs';
import { TRANSACTION_INPUT, transactionParseOptions } from './schemas.mjs';
import { sendTransactionError } from './errors.mjs';
import { transactionAuditRows } from './audit.mjs';
import { LIVE_STATUSES, offerReadiness, clubPartyRoleOf, actorLabel } from './transaction.mjs';
import { now } from '../../platform/clock.mjs';
import { strictContext } from '../../platform/deps.mjs';
import { createTransactionShared, ROLLBACK } from './shared.mjs';
import { registerAgentRoutes } from './agentRoutes.mjs';
import { registerAgentWorkflowRoutes } from './agentWorkflowRoutes.mjs';
import { registerDocumentRoutes } from './documentRoutes.mjs';
import { registerClubRoutes } from './clubRoutes.mjs';
import { registerPlayerRoutes } from './playerRoutes.mjs';
import { registerTsRoutes } from './tsRoutes.mjs';

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
    verificationReads,
    agentReads,
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

  // Each part adds what it offers the later ones, so the parts are created in this order and register their routes in
  // it. Reading a name a part has not been given yet throws outside production.
  const parts = {
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
    access,
    compliance,
    integration,
    recruitmentReads,
    scoutingReads,
    channels,
    verificationReads,
    agentReads,
    txs,
    repsRepo,
    docsRepo,
    entry,
    byAgent,
    byClubUser,
    byPlayer,
    bySystem,
    limitedOr429,
    inputOr400,
    clientKeyOr400,
    text,
    refuse,
    inUnit,
    txBook,
    bumpTx,
    rowBook,
    txById,
    repsOf,
    liveRepsOf,
    docsOf,
    orgById,
  };
  const ctx = strictContext('registerTransactions', parts);
  const { complianceOf, recheckCompliance, stalenessOf } = Object.assign(parts, createTransactionShared(ctx));
  registerAgentRoutes(ctx);
  registerAgentWorkflowRoutes(ctx);
  Object.assign(parts, registerDocumentRoutes(ctx));
  registerClubRoutes(ctx);
  registerPlayerRoutes(ctx);

  // ============================================================ the audit
  const auditRows = (filter) =>
    transactionAuditRows({ reads: agentTransactions.reads, snapshotOf: complianceOf }, filter);
  parts.auditRows = auditRows;
  registerTsRoutes(ctx);

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
