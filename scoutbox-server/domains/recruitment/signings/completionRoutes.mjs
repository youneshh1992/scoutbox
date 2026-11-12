/** Each party's completion, the signing's completion, and its cancellation, voiding and supersession by the club. */

import { rateLimitedBody } from '../../platform/rateLimit.mjs';
import { offerStatus as canonicalOfferStatus, effectiveRevisionStatus } from '../offers/offer.mjs';
import {
  SIGNING_LIMITS,
  payloadFingerprint,
  requiredPartiesFor,
  currentRevision,
  nextRevisionNumber,
  effectiveStatus,
  partiesComplete,
  canCompleteParty,
  canCancel,
  canVoid,
  canSupersede,
  completionGate,
  signingClubView,
  signingRecipientView,
  SIGNING_INPUT,
} from './signing.mjs';

/** Returns `completeParty`, which the player's completion goes through too. */
export function registerCompletionRoutes(ctx) {
  const {
    addKey,
    advanceCase,
    afterCommit,
    auditEntry,
    broadcast,
    byOrg,
    caseAudit,
    clientKey,
    documentBytesProblem,
    err,
    faults,
    findPlayer,
    hist,
    isBlocked,
    keyRow,
    limited,
    nextId,
    notifyAgent,
    notifyClubLeads,
    notifyPlayer,
    now,
    offerRevisionOf,
    orgOf,
    orgRouter,
    packageFor,
    packagesOf,
    recordCompletedSigning,
    recruitmentCases,
    replayOr,
    revGate,
    sg,
    SigningAbort,
    signingInput,
    sp,
    storeDocument,
    subjectRemoved,
    textOrRefuse,
    touch,
    unit,
  } = ctx;
  function completeParty(req, res, { pkg, kase, partyType, actorKind, actorId, actorName, rateKey, orgName }) {
    const at = now(req);
    const b = signingInput(res, actorKind === 'org' ? SIGNING_INPUT.clubParty : SIGNING_INPUT.recipientParty, req.body);
    if (!b) return;
    const key = clientKey(res, b);
    if (key === undefined) return;
    const fp = payloadFingerprint({
      partyType,
      revisionId: b.revisionId ?? null,
      documentSha256: b.documentSha256 ?? null,
    });
    const view = () =>
      actorKind === 'org'
        ? { signing: signingClubView(pkg, at, { orgName }) }
        : { signing: signingRecipientView(pkg, at, { orgName, partyType, forEntityId: actorId }) };
    if (key) {
      const row = keyRow(pkg, 'party', key);
      // A replay counts as the same signature only while its revision is still current; after a supersede the
      // old key does not answer `idempotent: true`.
      if (row) {
        if (row.fp === fp && row.actorId === actorId && (b.revisionId ?? null) === (pkg.currentRevisionId ?? null))
          return res.json({ ...view(), idempotent: true });
        return err(
          res,
          'SIGNING_IDEMPOTENCY_CONFLICT',
          row.fp === fp && row.actorId === actorId
            ? 'This clientKey signed a revision that is no longer current; sign the current revision with a new key.'
            : 'This clientKey was already used for a different request.',
        );
      }
    }
    if (actorKind === 'org' && !revGate(req, res, pkg, b)) return;
    if (isBlocked(pkg.playerId, pkg.orgId))
      return err(
        res,
        actorKind === 'org' ? 'SIGNING_BLOCKED' : 'SIGNING_STATE_INVALID',
        actorKind === 'org'
          ? 'This player (or their guardian) has blocked your organisation.'
          : 'This signing cannot be completed right now.',
      );
    if (subjectRemoved(kase)) return err(res, 'SIGNING_SUBJECT_REMOVED', 'This player removed their ScoutBox account.');
    const g = canCompleteParty(
      pkg,
      { partyType, actorKind, actorId, revisionId: b.revisionId, documentSha256: b.documentSha256 },
      at,
    );
    if (!g.ok)
      return err(res, g.error, g.message, {
        ...(g.current ? { current: g.current } : {}),
        ...(g.field ? { field: g.field } : {}),
      });
    if (kase.room?.status !== 'offer_accepted')
      return err(
        res,
        'SIGNING_LIFECYCLE_CONFLICT',
        'The case is no longer at Offer accepted; the club must resolve it before signatures continue.',
        { current: { status: kase.room?.status ?? null } },
      );
    {
      const dp = documentBytesProblem(pkg, g.revision.document);
      if (dp) {
        console.error(`SIGNING document_${dp} ${pkg.id} ${g.revision.id} at party completion`);
        return err(res, 'SIGNING_STATE_UNKNOWN', 'This signing cannot be confirmed: its document cannot be verified.');
      }
    }
    if (limited('signing_party_completion', rateKey))
      return res.status(429).json(rateLimitedBody('signing_party_completion'));
    const { revision: rev } = g;
    const by = { kind: actorKind, id: actorId, name: actorName };
    let fresh;
    try {
      fresh = unit(() => {
        let p = sp.setParty(pkg.id, rev.id, partyType, {
          status: 'COMPLETED',
          completedAt: at,
          completedBy: by,
          method: 'PLATFORM_ACKNOWLEDGMENT',
          evidenceRef: {
            kind: 'platform_acknowledgment',
            id: nextId('sgev'),
            revisionId: rev.id,
            documentSha256: rev.document.sha256,
            at,
            actorKind,
            actorId,
            session: 'authenticated',
          },
        });
        if (rev.status === 'READY') p = sp.patchRevision(p.id, rev.id, { status: 'IN_PROGRESS' });
        if (pkg.status === 'READY') p = sp.patch(p.id, { status: 'IN_PROGRESS' });
        if (key) p = addKey(p, 'party', { key, fp, actorId, revisionId: rev.id, at });
        p = hist(p, 'signing_party_completed', by, { revisionId: rev.id, partyType, sha256: rev.document.sha256 }, at);
        caseAudit(kase, actorKind, actorId, actorName, 'signing_party_completed', {
          signingPackageId: p.id,
          revisionId: rev.id,
          partyType,
        });
        p = touch(p, req, at, actorKind === 'org' ? req.orgUser : { id: actorId, name: actorName });
        const doneRev = currentRevision(p);
        broadcast?.('signing_party_completed', {
          orgId: p.orgId,
          roomId: kase.id,
          signingPackageId: p.id,
          revisionId: rev.id,
          partyType,
        });
        if (actorKind !== 'org')
          notifyClubLeads(
            p,
            `${actorName ?? 'The player'} confirmed the signing document for ${findPlayer(p.playerId)?.name ?? 'the player'}. ${partiesComplete(doneRev) ? 'Every required party has signed: a recruitment lead can now complete the signing.' : 'Waiting on the remaining party.'}`,
          );
        else
          notifyPlayer(
            p,
            `${orgName} has signed for the club. ${partiesComplete(doneRev) ? 'Every required party has now signed; the club completes the signing next.' : 'Your signature is still needed.'}`,
          );
        if (faults?.shouldFail?.('signing.party.after_write'))
          throw new Error('simulated failure after the party evidence write (development fault layer)');
        return p;
      });
    } catch (e) {
      console.error(`SIGNING party_completion_rolled_back ${pkg.id}: ${e?.message ?? e}`);
      return err(res, 'SIGNING_STATE_UNKNOWN', 'The signature could not be recorded; nothing was recorded.');
    }
    res.json(
      actorKind === 'org'
        ? { signing: signingClubView(fresh, at, { orgName }) }
        : { signing: signingRecipientView(fresh, at, { orgName, partyType, forEntityId: actorId }) },
    );
  }

  orgRouter.post('/signings/:id/parties/club/complete', (req, res) => {
    const got = packageFor(req, res, 'lead');
    if (!got) return;
    completeParty(req, res, {
      pkg: got.pkg,
      kase: got.kase,
      partyType: 'CLUB_SIGNATORY',
      actorKind: 'org',
      actorId: req.orgUser.id,
      actorName: req.orgUser.name,
      rateKey: `org:${req.orgUser.id}`,
      orgName: req.org.name,
    });
  });

  orgRouter.post('/signings/:id/executed-document', (req, res) => {
    const got = packageFor(req, res, 'manage');
    if (!got) return;
    const { pkg } = got;
    const at = now(req);
    const st = effectiveStatus(pkg, at);
    if (!['READY', 'IN_PROGRESS'].includes(st)) {
      const s = canVoid(pkg, at);
      return err(
        res,
        s.ok ? 'SIGNING_STATE_INVALID' : s.error,
        s.ok ? 'The executed document is attached to a presented signing.' : s.message,
        s.current ? { current: s.current } : {},
      );
    }
    const body = signingInput(res, SIGNING_INPUT.document, req.body);
    if (!body) return;
    if (!revGate(req, res, pkg, body)) return;
    if (limited('signing_document_write', req.org.id))
      return res.status(429).json(rateLimitedBody('signing_document_write'));
    const file = storeDocument(req, res, { pkg, kind: 'executed', body });
    if (!file) return;
    const rev = currentRevision(pkg);
    let fresh;
    try {
      fresh = unit(() => {
        const doc = file.record();
        let p = sp.setDocument(pkg.id, rev.id, 'executed', doc);
        p = hist(p, 'signing_executed_document_attached', byOrg(req), { revisionId: rev.id, sha256: doc.sha256 }, at);
        return touch(p, req, at);
      });
    } catch (e) {
      console.error(`SIGNING executed_document_rolled_back ${pkg.id}: ${e?.message ?? e}`);
      return err(res, 'SIGNING_STATE_UNKNOWN', 'The document could not be attached; nothing was recorded.');
    }
    res.json({ signing: signingClubView(fresh, at, { orgName: req.org.name }) });
  });

  /** Completion gate, signing writer, lifecycle move and notices as one unit; the invoice only after it commits. */
  orgRouter.post('/signings/:id/complete', (req, res) => {
    const got = packageFor(req, res, 'lead');
    if (!got) return;
    const { pkg, kase, offer } = got;
    const at = now(req);
    const body = signingInput(res, SIGNING_INPUT.complete, req.body);
    if (!body) return;
    const key = clientKey(res, body);
    if (key === undefined) return;
    const fp = payloadFingerprint({ complete: true });
    if (
      replayOr(pkg, 'complete', key, fp, res, () => ({
        signing: signingClubView(pkg, at, { orgName: req.org.name }),
        lifecycle: pkg.completion?.lifecycle ?? null,
      }))
    )
      return;
    if (pkg.status === 'COMPLETED') return err(res, 'SIGNING_ALREADY_COMPLETED', 'This signing is already completed.');
    if (!revGate(req, res, pkg, body)) return;
    const rev = currentRevision(pkg);
    const offerRev = offerRevisionOf(offer, pkg.offerRevisionId);
    const otherCompleted =
      packagesOf(pkg.offerId, pkg.orgId).some((p) => p.id !== pkg.id && effectiveStatus(p, at) === 'COMPLETED') ||
      !!sg.forOffer(pkg.offerId);
    const problems = completionGate(pkg, {
      documentProblem: rev?.document ? documentBytesProblem(pkg, rev.document) : 'missing',
      now: at,
      offer: offer ? { ...offer, status: canonicalOfferStatus(offer, at) } : null,
      offerRevision: offerRev ? { ...offerRev, status: effectiveRevisionStatus(offerRev, at) } : null,
      kase,
      otherCompleted,
      blocked: isBlocked(pkg.playerId, pkg.orgId),
    });
    if (problems.length) {
      const first = problems[0];
      if (first.startsWith('DOCUMENT_BYTES_')) {
        console.error(`SIGNING ${first.toLowerCase()} ${pkg.id} at completion`);
        return err(res, 'SIGNING_STATE_UNKNOWN', 'This signing cannot be completed: its document cannot be verified.');
      }
      const code =
        first === 'EXPIRED'
          ? 'SIGNING_EXPIRED'
          : first === 'ALREADY_COMPLETED'
            ? 'SIGNING_ALREADY_COMPLETED'
            : first === 'STATE_VOIDED'
              ? 'SIGNING_VOIDED'
              : first === 'STATE_CANCELLED'
                ? 'SIGNING_CANCELLED'
                : first === 'PARTIES_INCOMPLETE'
                  ? 'SIGNING_PARTIES_INCOMPLETE'
                  : first === 'DOCUMENT_REQUIRED'
                    ? 'SIGNING_DOCUMENT_REQUIRED'
                    : first === 'DOCUMENT_MISMATCH' || first === 'EVIDENCE_INVALID' || first === 'TEMPORAL_ORDER'
                      ? 'SIGNING_EVIDENCE_INVALID'
                      : first === 'BLOCKED'
                        ? 'SIGNING_BLOCKED'
                        : first === 'LIFECYCLE_CONFLICT'
                          ? 'SIGNING_LIFECYCLE_CONFLICT'
                          : first === 'OFFER_NOT_ACCEPTED' || first === 'OFFER_REVISION_MISMATCH'
                            ? 'SIGNING_OFFER_NOT_ACCEPTED'
                            : first === 'CONFLICTING_COMPLETED_SIGNING'
                              ? 'SIGNING_CONFLICT'
                              : first.startsWith('STATE_')
                                ? 'SIGNING_STATE_INVALID'
                                : 'SIGNING_STATE_UNKNOWN';
      return err(res, code, 'The signing cannot be completed yet.', {
        blockers: problems,
        current: { status: effectiveStatus(pkg, at) },
      });
    }
    if (subjectRemoved(kase)) return err(res, 'SIGNING_SUBJECT_REMOVED', 'This player removed their ScoutBox account.');
    const player = findPlayer(pkg.playerId);
    const org = orgOf(pkg.orgId);
    if (!player || !org) return err(res, 'SIGNING_STATE_UNKNOWN', 'This signing cannot be completed.');
    if (limited('signing_closure', req.org.id)) return res.status(429).json(rateLimitedBody('signing_closure'));
    // A SigningAbort or a throw anywhere, COMMIT included, rolls everything back and no invoice is issued.
    const by = byOrg(req);
    let moved = null;
    let signing = null;
    let fresh = null;
    try {
      fresh = unit(() => {
        // The signing row first, then the package's completion (`completion_signing_id` is a deferred key,
        // checked at COMMIT), then the revision.
        const written = recordCompletedSigning({ player, org, actor: req.orgUser, at, pkg, rev });
        if (written.duplicate)
          throw new SigningAbort(
            'SIGNING_ALREADY_COMPLETED',
            'A completed signing record already exists for this package.',
            { why: 'duplicate_row' },
          );
        signing = written.signing;
        if (faults?.shouldFail?.('signing.complete.after_row'))
          throw new Error('simulated failure after the signings row (development fault layer)');
        let p = sp.patchRevision(pkg.id, rev.id, { status: 'COMPLETED', completedAt: at, completedBy: by });
        p = sp.patch(p.id, {
          status: 'COMPLETED',
          completion: {
            signingId: signing.id,
            completedAt: at,
            completedBy: by,
            contract: rev.contract,
            documentSha256: rev.document.sha256,
            lifecycle: null,
          },
        });
        // The evidence provider now finds the row this completion just wrote.
        moved = advanceCase({
          req,
          room: kase,
          action: 'confirmSignedOutcome',
          at,
          trigger: `signing:complete:${pkg.id}`,
          keyDetail: { signingPackageId: pkg.id, signingId: signing.id },
        });
        if (!moved.applied)
          throw new SigningAbort(
            'SIGNING_LIFECYCLE_CONFLICT',
            moved.message ?? 'The case could not be moved to Signed; nothing was recorded.',
            { why: `lifecycle_${moved.reason}`, moved },
          );
        p = sp.patch(p.id, { completion: { ...p.completion, lifecycle: { from: moved.from, to: moved.to, at } } });
        if (faults?.shouldFail?.('signing.complete.after_lifecycle'))
          throw new Error('simulated failure after the lifecycle moved (development fault layer)');
        if (key) p = addKey(p, 'complete', { key, fp, signingId: signing.id, at });
        p = hist(
          p,
          'signing_completed',
          by,
          { revisionId: rev.id, signingId: signing.id, sha256: rev.document.sha256 },
          at,
        );
        recruitmentCases.cases.link(
          kase.id,
          { signingId: signing.id },
          {
            history: [
              auditEntry('org', req.orgUser.id, req.orgUser.name, 'signing_completed', {
                signingPackageId: p.id,
                signingId: signing.id,
                to: moved.to,
              }),
            ],
          },
        );
        p = touch(p, req, at);
        broadcast?.('signing_completed', {
          orgId: p.orgId,
          roomId: kase.id,
          signingPackageId: p.id,
          signingId: signing.id,
        });
        notifyAgent(p, `${org.name} completed the signing for your client ${player.name}.`);
        notifyClubLeads(p, `Signing completed for ${player.name}. The case reads Signed.`);
        afterCommit(() => {
          if (faults?.shouldFail?.('signing.complete.effects'))
            throw new Error('simulated failure in an after-commit effect (development fault layer)');
        });
        if (faults?.shouldFail?.('signing.complete.at_commit'))
          throw new Error('simulated failure at the commit of the completion unit (development fault layer)');
        return p;
      });
    } catch (e) {
      console.error(
        `SIGNING completion_rolled_back ${pkg.id}: ${e instanceof SigningAbort ? e.message : `threw ${e?.message ?? e}`}`,
      );
      if (e instanceof SigningAbort)
        return err(
          res,
          e.code,
          e.userMessage,
          e.moved ? { lifecycle: e.moved, current: { status: kase.room.status } } : {},
        );
      return err(res, 'SIGNING_STATE_UNKNOWN', 'The signing could not be completed; nothing was recorded.');
    }
    res.json({
      signing: signingClubView(fresh, at, { orgName: req.org.name }),
      lifecycle: moved,
      signingId: signing.id,
    });
  });

  function closeRoute(action) {
    return (req, res) => {
      const got = packageFor(req, res, action === 'cancel' ? 'manage' : 'lead');
      if (!got) return;
      const { pkg, kase } = got;
      const at = now(req);
      const body = signingInput(res, SIGNING_INPUT.close, req.body);
      if (!body) return;
      const key = clientKey(res, body);
      if (key === undefined) return;
      const reason = textOrRefuse(res, 'reason', body.reason, SIGNING_LIMITS.reason);
      if (reason === undefined) return;
      const fp = payloadFingerprint({ action, reason });
      if (replayOr(pkg, action, key, fp, res, () => ({ signing: signingClubView(pkg, at, { orgName: req.org.name }) })))
        return;
      const g = (action === 'cancel' ? canCancel : canVoid)(pkg, at);
      if (!g.ok) return err(res, g.error, g.message, g.current ? { current: g.current } : {});
      if (!revGate(req, res, pkg, body)) return;
      if (limited('signing_safety_closure', req.org.id))
        return res.status(429).json(rateLimitedBody('signing_safety_closure'));
      const by = byOrg(req);
      const rev = currentRevision(pkg);
      const status = action === 'cancel' ? 'CANCELLED' : 'VOIDED';
      let fresh;
      try {
        fresh = unit(
          () => {
            let p = sp.patchRevision(pkg.id, rev.id, { status });
            p = sp.patch(
              p.id,
              action === 'cancel'
                ? { status, cancelledAt: at, cancelledBy: by, cancelReason: reason }
                : { status, voidedAt: at, voidedBy: by, voidReason: reason },
            );
            if (key) p = addKey(p, action, { key, fp, at });
            p = hist(p, `signing_${status.toLowerCase()}`, by, { revisionId: rev.id, hadReason: !!reason }, at);
            caseAudit(kase, 'org', req.orgUser.id, req.orgUser.name, `signing_${status.toLowerCase()}`, {
              signingPackageId: p.id,
            });
            return touch(p, req, at);
          },
          (fresh) => {
            // Literal event names: the boot-time registry scanner reads the source and cannot see a computed name.
            if (action === 'cancel')
              broadcast?.('signing_cancelled', { orgId: fresh.orgId, roomId: kase.id, signingPackageId: fresh.id });
            else broadcast?.('signing_voided', { orgId: fresh.orgId, roomId: kase.id, signingPackageId: fresh.id });
            if (rev.readyAt)
              notifyPlayer(
                fresh,
                `${req.org.name} ${action === 'cancel' ? 'cancelled' : 'voided'} the signing presented to you. Nothing was signed. Your accepted Offer is unchanged.`,
              );
          },
        );
      } catch (e) {
        console.error(`SIGNING ${action}_rolled_back ${pkg.id}: ${e?.message ?? e}`);
        return err(res, 'SIGNING_STATE_UNKNOWN', 'The signing could not be closed; nothing was recorded.');
      }
      res.json({ signing: signingClubView(fresh, at, { orgName: req.org.name }) });
    };
  }
  orgRouter.post('/signings/:id/cancel', closeRoute('cancel'));
  orgRouter.post('/signings/:id/void', closeRoute('void'));

  /** The presented revision is SUPERSEDED and a fresh DRAFT opens with the same contract days, all parties pending. */
  orgRouter.post('/signings/:id/supersede', (req, res) => {
    const got = packageFor(req, res, 'manage');
    if (!got) return;
    const { pkg, kase } = got;
    const at = now(req);
    const body = signingInput(res, SIGNING_INPUT.close, req.body);
    if (!body) return;
    const key = clientKey(res, body);
    if (key === undefined) return;
    const reason = textOrRefuse(res, 'reason', body.reason, SIGNING_LIMITS.reason);
    if (reason === undefined) return;
    const fp = payloadFingerprint({ supersede: true, reason });
    if (
      replayOr(pkg, 'supersede', key, fp, res, () => ({ signing: signingClubView(pkg, at, { orgName: req.org.name }) }))
    )
      return;
    const g = canSupersede(pkg, at);
    if (!g.ok) return err(res, g.error, g.message, g.current ? { current: g.current } : {});
    if (!revGate(req, res, pkg, body)) return;
    if (limited('signing_document_write', req.org.id))
      return res.status(429).json(rateLimitedBody('signing_document_write'));
    const by = byOrg(req);
    const prev = currentRevision(pkg);
    const acceptedRev = offerRevisionOf(got.offer, pkg.offerRevisionId);
    const rev = {
      id: nextId('spr'),
      revisionNumber: nextRevisionNumber(pkg),
      status: 'DRAFT',
      createdAt: at,
      createdBy: by,
      readyAt: null,
      readyBy: null,
      completedAt: null,
      document: null,
      executedDocument: null,
      contract: { ...prev.contract },
      requiredParties: requiredPartiesFor({
        recipientType: acceptedRev?.recipientSnapshot?.type ?? 'player',
        playerId: pkg.playerId,
        guardianId: acceptedRev?.recipientSnapshot?.guardianId ?? null,
        orgId: pkg.orgId,
      }),
      policySnapshot: { ...prev.policySnapshot },
      supersedesRevisionId: prev.id,
      supersededByRevisionId: null,
    };
    let fresh;
    try {
      fresh = unit(
        () => {
          let p = sp.patchRevision(pkg.id, prev.id, {
            status: 'SUPERSEDED',
            supersededByRevisionId: rev.id,
            supersededAt: at,
          });
          p = sp.addRevision(p.id, rev);
          p = sp.patch(p.id, { currentRevisionId: rev.id, status: 'DRAFT' });
          if (key) p = addKey(p, 'supersede', { key, fp, revisionId: rev.id, at });
          p = hist(p, 'signing_superseded', by, { revisionId: rev.id, supersedes: prev.id, hadReason: !!reason }, at);
          caseAudit(kase, 'org', req.orgUser.id, req.orgUser.name, 'signing_superseded', {
            signingPackageId: p.id,
            revisionId: rev.id,
            supersedes: prev.id,
          });
          return touch(p, req, at);
        },
        (fresh) => {
          broadcast?.('signing_superseded', {
            orgId: fresh.orgId,
            roomId: kase.id,
            signingPackageId: fresh.id,
            revisionId: rev.id,
            supersedes: prev.id,
          });
          notifyPlayer(
            fresh,
            `${req.org.name} withdrew the document presented to you; any confirmation you gave no longer applies. A new document will be presented before anything is signed.`,
          );
        },
      );
    } catch (e) {
      console.error(`SIGNING supersede_rolled_back ${pkg.id}: ${e?.message ?? e}`);
      return err(res, 'SIGNING_STATE_UNKNOWN', 'The signing could not be superseded; nothing was recorded.');
    }
    res.status(201).json({ signing: signingClubView(fresh, at, { orgName: req.org.name }) });
  });

  return { completeParty };
}
