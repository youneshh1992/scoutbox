/** A club party's lane: its transactions, its confirmation, documents, notes and links. */

import { guardRev } from '../../platform/concurrency.mjs';
import { readPage, sendPageError } from '../../platform/paging.mjs';
import { sendTransactionError, notFound } from './errors.mjs';
import {
  partiesOf,
  TRANSACTION_STATUSES,
  DOCUMENT_TYPES,
  canSeeVisibility,
  uploadableVisibilities,
  roomRolesFor,
  timelineFor,
  TRANSACTION_LIMITS,
} from './transaction.mjs';
import { now } from '../../platform/clock.mjs';
import { HONEST_TRANSACTION } from './shared.mjs';

export function registerClubRoutes(ctx) {
  const {
    addDocument,
    addNote,
    batchFor,
    broadcast,
    bumpTx,
    byClubUser,
    channels,
    clubTransaction,
    clubViewer,
    docsOf,
    documentView,
    entry,
    inputOr400,
    inUnit,
    limitedOr429,
    nextId,
    notify,
    orgRouter,
    pageItems,
    partyChanged,
    projectTransaction,
    readDocumentReference,
    recruitmentReads,
    TX_CONFLICT,
    txBook,
    txById,
    txs,
    writableOr,
  } = ctx;
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
}
