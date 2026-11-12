/** The player party's lane: their transactions, their confirmation and their documents. */

import { guardRev } from '../../platform/concurrency.mjs';
import { notFound } from './errors.mjs';
import {
  partiesOf,
  TRANSACTION_STATUSES,
  DOCUMENT_TYPES,
  canSeeVisibility,
  uploadableVisibilities,
  roomRolesFor,
  timelineFor,
} from './transaction.mjs';
import { now } from '../../platform/clock.mjs';
import { HONEST_TRANSACTION } from './shared.mjs';

export function registerPlayerRoutes(ctx) {
  const {
    addDocument,
    batchFor,
    broadcast,
    bumpTx,
    byPlayer,
    docsOf,
    documentView,
    entry,
    inputOr400,
    inUnit,
    limitedOr429,
    notify,
    partyChanged,
    playerRouter,
    playerTransaction,
    playerViewer,
    projectTransaction,
    readDocumentReference,
    TX_CONFLICT,
    txBook,
    txById,
    txs,
    writableOr,
  } = ctx;
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
}
