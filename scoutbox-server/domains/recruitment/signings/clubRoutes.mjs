/** The club's signing routes up to presentation: opening a package, its terms and document, and READY. */

import { roomCan } from '../rooms/shared.mjs';
import { rateLimitedBody } from '../../platform/rateLimit.mjs';
import { offerStatus as canonicalOfferStatus, effectiveRevisionStatus } from '../offers/offer.mjs';
import { sendSigningError, notFound, documentNotFound } from './errors.mjs';
import {
  SIGNING_POLICY_VERSION,
  SIGNING_STATUSES,
  SIGNING_STATUS_LABELS,
  SIGNING_METHODS,
  SIGNING_LIMITS,
  PARTY_TYPES,
  MINOR_SIGNING_PATHWAY_ENABLED,
  minorSigningPathwayOpen,
  payloadFingerprint,
  validateContractDates,
  validateExpiry,
  requiredPartiesFor,
  currentRevision,
  effectiveStatus,
  isLive,
  canStart,
  canAttachDocument,
  canMarkReady,
  signingIntegrity,
  signingClubView,
  signingHistoryView,
  SIGNING_INPUT,
} from './signing.mjs';

export function registerClubRoutes(ctx) {
  const {
    addKey,
    broadcast,
    byOrg,
    caseAudit,
    caseOfOrg,
    clientKey,
    consistencyOf,
    documentBytesProblem,
    documentFile,
    err,
    findPlayer,
    hist,
    isAdult,
    isBlocked,
    isLead,
    limited,
    nextId,
    notifyAgent,
    notifyPlayer,
    now,
    offerOf,
    offerReads,
    orgOf,
    orgRouter,
    packageFor,
    packagesOf,
    packagesOfCase,
    replayOr,
    revGate,
    roleFor,
    roomFor,
    sg,
    signingInput,
    sp,
    storeDocument,
    subjectRemoved,
    textOrRefuse,
    touch,
    unit,
  } = ctx;
  function startBlockers(kase, role, at) {
    const blockers = [];
    if (!roomCan(role, 'offer_issue')) blockers.push('SIGNING_ROLE');
    if (subjectRemoved(kase)) blockers.push('SUBJECT_REMOVED');
    if (isBlocked(kase.playerId, kase.orgId)) blockers.push('BLOCKED');
    if (kase.room?.status !== 'offer_accepted') blockers.push('CASE_STATE');
    // Names the closed minor pathway before anyone tries, whatever the Offer's state.
    const subject = findPlayer(kase.playerId);
    if (
      subject &&
      typeof isAdult === 'function' &&
      !isAdult(subject) &&
      !minorSigningPathwayOpen(orgOf(kase.orgId)?.country ?? 'GB')
    )
      blockers.push('MINOR_PATHWAY_CLOSED');
    const accepted =
      offerReads.forCase(kase.id).find((o) => o.orgId === kase.orgId && canonicalOfferStatus(o, at) === 'ACCEPTED') ??
      null;
    if (!accepted) blockers.push('OFFER_NOT_ACCEPTED');
    else {
      const rev = (accepted.revisions ?? []).find((r) => r && effectiveRevisionStatus(r, at) === 'ACCEPTED') ?? null;
      if (rev?.recipientSnapshot?.type === 'guardian' && !minorSigningPathwayOpen(orgOf(kase.orgId)?.country ?? 'GB'))
        blockers.push('MINOR_PATHWAY_CLOSED');
      const existing = packagesOf(accepted.id, kase.orgId);
      if (existing.some((p) => effectiveStatus(p, at) === 'COMPLETED')) blockers.push('ALREADY_COMPLETED');
      else if (existing.some((p) => isLive(p, at))) blockers.push('PACKAGE_LIVE');
    }
    return { blockers: [...new Set(blockers)], accepted };
  }

  orgRouter.get('/rooms/:id/signing', (req, res) => {
    const got = roomFor(req, res, 'offer_view');
    if (!got) return;
    const { room: kase, role } = got;
    const at = now(req);
    const packages = packagesOfCase(kase)
      .map((p) => ({
        ...signingClubView(p, at, { orgName: orgOf(p.orgId)?.name ?? null }),
        integrity: [
          ...signingIntegrity(p, { orgId: kase.orgId }),
          ...(offerOf(p) ? consistencyOf(p, offerOf(p), kase, at) : ['OFFER_MISSING']),
        ],
      }))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const live = packagesOfCase(kase).find((p) => isLive(p, at)) ?? null;
    const { blockers, accepted } = startBlockers(kase, role, at);
    const legacySigning = sg.forOrgPlayer(kase.orgId, kase.playerId).find((s) => !s.signingPackageId) ?? null;
    res.json({
      packages,
      livePackageId: live?.id ?? null,
      legacySigning: legacySigning
        ? { id: legacySigning.id, at: legacySigning.ts ?? null, method: legacySigning.method ?? 'LEGACY_RECORDED' }
        : null,
      requirements: {
        role,
        canManage: roomCan(role, 'offer_issue'),
        canComplete: isLead(req.orgUser),
        status: kase.room?.status ?? null,
        startBlockers: blockers,
        acceptedOfferId: accepted?.id ?? null,
      },
      vocabulary: {
        statuses: SIGNING_STATUSES,
        statusLabels: SIGNING_STATUS_LABELS,
        partyTypes: PARTY_TYPES,
        methods: SIGNING_METHODS,
        minorPathway: MINOR_SIGNING_PATHWAY_ENABLED,
      },
      policyVersion: SIGNING_POLICY_VERSION,
      honest:
        'An accepted Offer is not a signing. A signing is completed only when every required party has confirmed the exact document and a recruitment lead completes the package; only then does the case read Signed.',
    });
  });

  orgRouter.post('/offers/:id/signing', (req, res) => {
    const found = offerReads.byId(req.params.id);
    const offer = found && found.orgId === req.org.id ? found : null;
    if (!offer) return notFound(res, 'club');
    const kase = caseOfOrg(offer.caseId, req.org.id);
    if (!kase || !kase.room) return notFound(res, 'club');
    const role = roleFor(req, kase);
    if (!roomCan(role, 'offer_view'))
      return err(res, 'SIGNING_NOT_PERMITTED', 'Your role cannot read signings on this case.');
    if (!roomCan(role, 'offer_issue'))
      return err(res, 'SIGNING_NOT_PERMITTED', 'Only a room lead or recruitment lead can open a signing.');
    const at = now(req);
    const b = signingInput(res, SIGNING_INPUT.start, req.body);
    if (!b) return;
    const key = clientKey(res, b);
    if (key === undefined) return;
    const acceptedRev = (offer.revisions ?? []).find((r) => r && effectiveRevisionStatus(r, at) === 'ACCEPTED') ?? null;
    const contractIn = {
      startDate: b.contract?.startDate ?? acceptedRev?.terms?.startDate ?? null,
      endDate: b.contract?.endDate ?? acceptedRev?.terms?.endDate ?? null,
    };
    const internalNote = textOrRefuse(res, 'internalNote', b.internalNote, SIGNING_LIMITS.internalNote);
    if (internalNote === undefined) return;
    const fp = payloadFingerprint({
      offerId: offer.id,
      contract: contractIn,
      internalNote,
      expiresAt: b.expiresAt ?? null,
    });
    if (key) {
      const prior = packagesOf(offer.id, req.org.id).find((p) => p.keys?.start?.key === key);
      if (prior)
        return prior.keys.start.fp === fp
          ? res.json({ signing: signingClubView(prior, at, { orgName: req.org.name }), idempotent: true })
          : err(res, 'SIGNING_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different request.');
    }
    if (subjectRemoved(kase))
      return err(
        res,
        'SIGNING_SUBJECT_REMOVED',
        'This player removed their ScoutBox account. No signing is opened about a person who left.',
      );
    if (isBlocked(kase.playerId, kase.orgId))
      return err(
        res,
        'SIGNING_BLOCKED',
        'This player (or their guardian) has blocked your organisation. No signing is opened while the block stands.',
      );
    const gate = canStart(
      {
        offerStatus: canonicalOfferStatus(offer, at),
        offerRevisionStatus: acceptedRev ? effectiveRevisionStatus(acceptedRev, at) : null,
        caseStatus: kase.room?.status,
        recipientType: acceptedRev?.recipientSnapshot?.type ?? null,
        jurisdiction: orgOf(kase.orgId)?.country ?? 'GB',
        existing: packagesOf(offer.id, req.org.id),
      },
      at,
    );
    if (!gate.ok) return err(res, gate.error, gate.message, gate.current ? { current: gate.current } : {});
    if (offer.playerId !== kase.playerId) {
      console.error(`SIGNING offer/case player mismatch ${offer.id}`);
      return err(res, 'SIGNING_STATE_UNKNOWN', 'This Offer cannot be read.');
    }
    const contract = validateContractDates(contractIn);
    if (!contract.ok) return sendSigningError(res, contract, 'club');
    const expiry = validateExpiry(b.expiresAt, { now: at });
    if (!expiry.ok) return sendSigningError(res, expiry, 'club');
    if (limited('signing_start', req.org.id)) return res.status(429).json(rateLimitedBody('signing_start'));
    const by = byOrg(req);
    const rev = {
      id: nextId('spr'),
      revisionNumber: 1,
      status: 'DRAFT',
      createdAt: at,
      createdBy: by,
      readyAt: null,
      readyBy: null,
      completedAt: null,
      document: null,
      executedDocument: null,
      contract: contract.contract,
      requiredParties: requiredPartiesFor({
        recipientType: acceptedRev.recipientSnapshot.type,
        playerId: kase.playerId,
        guardianId: acceptedRev.recipientSnapshot.guardianId ?? null,
        orgId: kase.orgId,
      }),
      policySnapshot: {
        policyVersion: SIGNING_POLICY_VERSION,
        jurisdiction: orgOf(kase.orgId)?.country ?? 'GB',
        offerPolicyVersion: offer.policyVersion ?? null,
      },
      supersedesRevisionId: null,
      supersededByRevisionId: null,
    };
    const pkg = {
      id: nextId('spk'),
      orgId: kase.orgId,
      caseId: kase.id,
      playerId: kase.playerId,
      offerId: offer.id,
      offerRevisionId: acceptedRev.id,
      transactionId: offer.transactionId ?? null,
      status: 'DRAFT',
      currentRevisionId: rev.id,
      revisions: [rev],
      expiresAt: expiry.ms,
      internalNote,
      keys: {
        start: key ? { key, fp } : null,
        ready: [],
        party: [],
        cancel: [],
        void: [],
        supersede: [],
        complete: [],
      },
      history: [],
      completion: null,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      createdAt: at,
      createdBy: by,
      updatedAt: at,
      rev: 1,
      revAt: at,
      revBy: { userId: by.id, name: by.name },
      policyVersion: SIGNING_POLICY_VERSION,
    };
    let stored;
    try {
      stored = unit(
        () => {
          sp.insert(pkg);
          const fresh = hist(
            pkg,
            'signing_created',
            by,
            { revisionId: rev.id, offerId: offer.id, offerRevisionId: acceptedRev.id },
            at,
          );
          caseAudit(kase, 'org', req.orgUser.id, req.orgUser.name, 'signing_created', {
            signingPackageId: pkg.id,
            offerId: offer.id,
          });
          return fresh;
        },
        (stored) => {
          broadcast?.('signing_created', {
            orgId: stored.orgId,
            roomId: kase.id,
            signingPackageId: stored.id,
            offerId: offer.id,
          });
        },
      );
    } catch (e) {
      console.error(`SIGNING start_rolled_back ${pkg.id}: ${e?.message ?? e}`);
      return err(res, 'SIGNING_STATE_UNKNOWN', 'The signing could not be opened; nothing was recorded.');
    }
    res.status(201).json({ signing: signingClubView(stored, at, { orgName: req.org.name }) });
  });

  orgRouter.get('/signings/:id', (req, res) => {
    const got = packageFor(req, res, 'view');
    if (!got) return;
    res.json({ signing: signingClubView(got.pkg, now(req), { orgName: req.org.name }), integrity: got.consistency });
  });
  orgRouter.get('/signings/:id/history', (req, res) => {
    const got = packageFor(req, res, 'view');
    if (!got) return;
    res.json({ items: signingHistoryView(got.pkg), signingPackageId: got.pkg.id });
  });
  orgRouter.get('/signings/:id/document', (req, res) => {
    const got = packageFor(req, res, 'view');
    if (!got) return;
    const q = signingInput(res, SIGNING_INPUT.documentQuery, req.query, { root: 'query' });
    if (!q) return;
    const which = q.kind === 'executed' ? 'executedDocument' : 'document';
    const revId = q.revisionId ?? got.pkg.currentRevisionId;
    const rev = (got.pkg.revisions ?? []).find((r) => r && r.id === revId);
    if (rev?.[which]) {
      const dp = documentBytesProblem(got.pkg, rev[which]);
      if (dp) {
        console.error(`SIGNING document_${dp} ${got.pkg.id} ${rev.id} ${which}`);
        return err(res, 'SIGNING_STATE_UNKNOWN', 'This document cannot be read.');
      }
    }
    const out = rev?.[which] ? documentFile(rev[which], req.org.id) : null;
    if (!out) return documentNotFound(res, 'club');
    res.json(out);
  });

  orgRouter.patch('/signings/:id', (req, res) => {
    const got = packageFor(req, res, 'manage');
    if (!got) return;
    const { pkg } = got;
    const at = now(req);
    const s = canAttachDocument(pkg, at);
    if (!s.ok) return err(res, s.error, s.message, s.current ? { current: s.current } : {});
    const b = signingInput(res, SIGNING_INPUT.draftEdit, req.body);
    if (!b) return;
    if (!revGate(req, res, pkg, b)) return;
    const rev = currentRevision(pkg);
    let contract = null;
    let internalNote;
    if (b.contract !== undefined) {
      const c = validateContractDates({
        startDate: b.contract?.startDate ?? rev.contract?.startDate,
        endDate: b.contract?.endDate === undefined ? rev.contract?.endDate : b.contract?.endDate,
      });
      if (!c.ok) return sendSigningError(res, c, 'club');
      contract = c.contract;
    }
    if (b.internalNote !== undefined) {
      internalNote = textOrRefuse(res, 'internalNote', b.internalNote, SIGNING_LIMITS.internalNote);
      if (internalNote === undefined) return;
    }
    if (limited('signing_document_write', req.org.id))
      return res.status(429).json(rateLimitedBody('signing_document_write'));
    let fresh;
    try {
      fresh = unit(() => {
        let p = pkg;
        if (contract) p = sp.patchRevision(p.id, rev.id, { contract });
        if (internalNote !== undefined) p = sp.patch(p.id, { internalNote });
        p = hist(p, 'signing_draft_updated', byOrg(req), { revisionId: rev.id }, at);
        return touch(p, req, at);
      });
    } catch (e) {
      console.error(`SIGNING draft_update_rolled_back ${pkg.id}: ${e?.message ?? e}`);
      return err(res, 'SIGNING_STATE_UNKNOWN', 'The change could not be recorded; nothing was recorded.');
    }
    res.json({ signing: signingClubView(fresh, at, { orgName: req.org.name }) });
  });

  orgRouter.post('/signings/:id/document', (req, res) => {
    const got = packageFor(req, res, 'manage');
    if (!got) return;
    const { pkg } = got;
    const at = now(req);
    const s = canAttachDocument(pkg, at);
    if (!s.ok) return err(res, s.error, s.message, s.current ? { current: s.current } : {});
    const body = signingInput(res, SIGNING_INPUT.document, req.body);
    if (!body) return;
    if (!revGate(req, res, pkg, body)) return;
    if (limited('signing_document_write', req.org.id))
      return res.status(429).json(rateLimitedBody('signing_document_write'));
    const file = storeDocument(req, res, { pkg, kind: 'signing', body });
    if (!file) return;
    const rev = currentRevision(pkg);
    let fresh;
    try {
      fresh = unit(() => {
        const doc = file.record();
        let p = sp.setDocument(pkg.id, rev.id, 'signing', doc);
        p = hist(p, 'signing_document_attached', byOrg(req), { revisionId: rev.id, sha256: doc.sha256 }, at);
        return touch(p, req, at);
      });
    } catch (e) {
      console.error(`SIGNING document_rolled_back ${pkg.id}: ${e?.message ?? e}`);
      return err(res, 'SIGNING_STATE_UNKNOWN', 'The document could not be attached; nothing was recorded.');
    }
    res.json({ signing: signingClubView(fresh, at, { orgName: req.org.name }) });
  });

  orgRouter.post('/signings/:id/ready', (req, res) => {
    const got = packageFor(req, res, 'manage');
    if (!got) return;
    const { pkg, kase } = got;
    const at = now(req);
    const body = signingInput(res, SIGNING_INPUT.ready, req.body);
    if (!body) return;
    const key = clientKey(res, body);
    if (key === undefined) return;
    const fp = payloadFingerprint({ expiresAt: body.expiresAt ?? null });
    if (replayOr(pkg, 'ready', key, fp, res, () => ({ signing: signingClubView(pkg, at, { orgName: req.org.name }) })))
      return;
    const s = canMarkReady(pkg, at);
    if (!s.ok)
      return err(res, s.error, s.message, {
        ...(s.current ? { current: s.current } : {}),
        ...(s.field ? { field: s.field } : {}),
      });
    if (!revGate(req, res, pkg, body)) return;
    if (isBlocked(pkg.playerId, pkg.orgId))
      return err(
        res,
        'SIGNING_BLOCKED',
        'This player (or their guardian) has blocked your organisation. Nothing is presented while the block stands.',
      );
    if (subjectRemoved(kase)) return err(res, 'SIGNING_SUBJECT_REMOVED', 'This player removed their ScoutBox account.');
    let expiresAt = pkg.expiresAt;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      const e = validateExpiry(body.expiresAt, { now: at });
      if (!e.ok) return sendSigningError(res, e, 'club');
      expiresAt = e.ms;
    }
    const rev = currentRevision(pkg);
    const dp = documentBytesProblem(pkg, rev.document);
    if (dp) {
      console.error(`SIGNING document_${dp} ${pkg.id} ${rev.id} at ready`);
      return err(res, 'SIGNING_STATE_UNKNOWN', 'This signing cannot be presented: its document cannot be verified.');
    }
    if (limited('signing_document_write', req.org.id))
      return res.status(429).json(rateLimitedBody('signing_document_write'));
    const by = byOrg(req);
    let fresh;
    try {
      fresh = unit(
        () => {
          let p = sp.patchRevision(pkg.id, rev.id, { status: 'READY', readyAt: at, readyBy: by });
          p = sp.patch(p.id, { status: 'READY', expiresAt });
          if (key) p = addKey(p, 'ready', { key, fp, revisionId: rev.id, at });
          p = hist(p, 'signing_ready', by, { revisionId: rev.id, sha256: rev.document.sha256 }, at);
          caseAudit(kase, 'org', req.orgUser.id, req.orgUser.name, 'signing_ready', {
            signingPackageId: p.id,
            revisionId: rev.id,
          });
          return touch(p, req, at);
        },
        (fresh) => {
          broadcast?.('signing_ready', {
            orgId: fresh.orgId,
            roomId: kase.id,
            signingPackageId: fresh.id,
            revisionId: rev.id,
          });
          notifyPlayer(
            fresh,
            `${req.org.name} has presented your contract for signing. Read the exact document in ScoutBox and confirm it when you are ready; nothing is signed until you do.`,
          );
          notifyAgent(
            fresh,
            `Your client ${findPlayer(fresh.playerId)?.name ?? ''} was presented a document to sign by ${req.org.name}. Their signature is their own act.`.replace(
              /\s+/g,
              ' ',
            ),
          );
        },
      );
    } catch (e) {
      console.error(`SIGNING ready_rolled_back ${pkg.id}: ${e?.message ?? e}`);
      return err(res, 'SIGNING_STATE_UNKNOWN', 'The signing could not be presented; nothing was recorded.');
    }
    res.json({ signing: signingClubView(fresh, at, { orgName: req.org.name }) });
  });
}
