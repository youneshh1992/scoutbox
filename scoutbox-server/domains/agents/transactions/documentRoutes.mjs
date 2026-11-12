import { guardRev } from '../../platform/concurrency.mjs';
import { payloadFingerprint } from '../../platform/idempotency.mjs';
import { isExpiredAt, isAbsent, parseDateOrInstant } from '../../../temporal.mjs';
import { sendTransactionError } from './errors.mjs';
import {
  partiesOf,
  DOCUMENT_TYPES,
  NOTE_VISIBILITY,
  canSeeVisibility,
  uploadableVisibilities,
  roomRolesFor,
  timelineFor,
  actorLabel,
  TRANSACTION_LIMITS,
} from './transaction.mjs';
import { now } from '../../platform/clock.mjs';

/** Returns `addDocument`, `readDocumentReference` and `addNote` for the club and player lanes. */
export function registerDocumentRoutes(ctx) {
  const {
    agentViewer,
    broadcast,
    bumpTx,
    byAgent,
    channelReadableBy,
    clientKeyOr400,
    docsOf,
    docsRepo,
    documentView,
    entry,
    inputOr400,
    inUnit,
    limitedOr429,
    nextId,
    notify,
    notifyParty,
    orgRouter,
    ownTransaction,
    rowBook,
    text,
    TX_CONFLICT,
    txBook,
    txs,
    verificationReads,
    writableOr,
  } = ctx;
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
      const ev = verificationReads.evidence.byId(ref.id.trim());
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

  return { addDocument, readDocumentReference, addNote };
}
