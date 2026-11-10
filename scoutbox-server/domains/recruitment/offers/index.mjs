/**
 * Offer routes, for the club, the recipient (player or guardian) and a shared agent. Case status moves only
 * through `ctx.applyLifecycleTransition`, after the lifecycle validator agreed with the real evidence provider.
 */

import { buildRouteHelpers } from '../../platform/routeHelpers.mjs';
import { requestClock } from '../../platform/clock.mjs';
import { sideEffectRunner } from '../../platform/sideEffects.mjs';
import { roomRole, roomCan, ROOM_STATUS_LABELS } from '../rooms/shared.mjs';
import { guardRev, expectedRevOf } from '../../platform/concurrency.mjs';
import { rateLimitedBody, limitCheck } from '../../platform/rateLimit.mjs';
import {
  canTransitionRecruitmentCase,
  NULL_EVIDENCE_PROVIDER,
  RECRUITMENT_LIFECYCLE_POLICY_VERSION,
} from '../lifecycle/lifecycle.mjs';
import { resolveContactRecipient } from '../lifecycle/contact.mjs';
import { visibleToOrg } from '../../../domain.mjs';
import { sendOfferError, notFound, documentNotFound } from './errors.mjs';
import {
  OFFER_POLICY_VERSION,
  OFFER_STATUSES,
  OFFER_STATUS_LABELS,
  OFFER_TYPES,
  OFFER_LIMITS,
  OFFER_RESPONSE_TYPES,
  MINOR_OFFER_PATHWAY_ENABLED,
  minorOfferPathwayOpen,
  normaliseOfferClientKey,
  payloadFingerprint,
  validateTerms,
  validateMessages,
  validateExpiry,
  validateDocumentRefs,
  effectiveRevisionStatus,
  currentRevision,
  liveRevision,
  liveStatus,
  wasIssued,
  offerStatus,
  canRevise,
  canRespondToRevision,
  canWithdrawRevision,
  responderMatches,
  nextRevisionNumber,
  offerIntegrity,
  offerCaseConsistency,
  offerCaseCorrupt,
  offerClubView,
  offerRecipientView,
  offerAgentView,
  offerHistoryView,
} from './offer.mjs';

export function registerOffers(rawCtx) {
  // Shared helpers, so an Offer is led, concealed and audited by the same rules as a Room.
  const ctx = { ...rawCtx, ...buildRouteHelpers(rawCtx) };
  const {
    guardians,
    orgRouter,
    playerRouter,
    guardianRouter,
    nextId,
    notify,
    broadcast,
    findPlayer,
    isBlocked,
    rateLimit,
    isLead,
    moderateOrRefuse,
    auditEntry,
    orgCanSee,
    isAdult,
    storage,
    access = null,
    integration = null,
    transactions = null,
    faults = null,
    signingSummary,
    recruitmentContactsOffers,
    unit,
    afterCommit,
    recruitmentReads,
    verificationReads, // the document vault
  } = ctx;
  const vaultRecord = (id) => (typeof id === 'string' ? (verificationReads?.evidence.byId(id) ?? null) : null);
  const caseAudit = (kase, ...entry) =>
    ctx.recruitmentCases.cases.recordAct(kase.id, { history: [auditEntry(...entry)] });
  if (typeof unit !== 'function' || typeof afterCommit !== 'function' || !recruitmentContactsOffers?.offers)
    throw new TypeError(
      'registerOffers needs the contacts/offers repository, unit and afterCommit from the data layer',
    );
  if (typeof signingSummary !== 'function')
    throw new TypeError("registerOffers needs the signings domain's summaryForOffer (ctx.signingSummary)");
  const offers = recruitmentContactsOffers.offers;
  const caseOfOrg = (id, orgId) => {
    const k = recruitmentReads.cases.byId(id);
    return k && k.orgId === orgId ? k : null;
  };

  const err = (res, error, message, extra = {}) => sendOfferError(res, { error, message, ...extra }, 'offer');
  const limited = limitCheck(rateLimit);
  const roleFor = (req, room) => roomRole({ room, user: req.orgUser, isLead: isLead(req.orgUser) });
  const evidenceProvider = () => ctx.recruitmentEvidenceProvider ?? NULL_EVIDENCE_PROVIDER;
  const orgOf = (orgId) => ctx.byId.org(orgId);
  const now = requestClock();
  const byOrg = (req) => ({ kind: 'org', id: req.orgUser.id, name: req.orgUser.name, role: req.orgUser.role ?? null });
  const entry = (action, by, detail, at) => ({
    id: nextId('aud'),
    at,
    action,
    by: { kind: by.kind, id: by.id ?? null, name: by.name ?? null },
    detail: detail ?? null,
  });

  /** Idempotency keys live on the record, one list per act. */
  const keyRow = (offer, act, k) => (offer.keys?.[act] ?? []).find((x) => x && x.key === k) ?? null;
  /**
   * A refusal decided inside a unit (the case cannot take the move the Offer asks for): thrown so the unit
   * rolls back the Offer and the case together, then answered by the route rather than as a 500.
   */
  class OfferRefusal extends Error {
    constructor(body) {
      super(body.error);
      this.body = body;
    }
  }
  /** Returns undefined when it has already answered. */
  const inUnit = (res, work) => {
    try {
      return { value: unit(work) };
    } catch (e) {
      if (!(e instanceof OfferRefusal)) throw e;
      const { error, message, ...extra } = e.body;
      err(res, error, message, extra);
      return undefined;
    }
  };

  // A side effect that throws after the state was persisted is logged, not turned into a 500 the client
  // would retry.
  const safe = sideEffectRunner('OFFER');

  // An accepted Offer with no signing package reads `signing: null`: nothing is inferred.
  const withSigning = (o, at, view) => ({ ...view, signing: signingSummary(o.id, o.orgId, at) });
  const clubView = (o, at) => withSigning(o, at, offerClubView(o, at));

  // ------------------------------------------------------------- lookups

  function roomFor(req, res, need) {
    const room = ctx.findRoomForRequest(req, res);
    if (!room) return null;
    const role = roleFor(req, room);
    if (!roomCan(role, need)) {
      err(
        res,
        'OFFER_NOT_PERMITTED',
        need === 'offer_view'
          ? 'Your role cannot read Offers on this case.'
          : 'Only a room lead or recruitment lead can draft, issue or withdraw an Offer.',
      );
      return null;
    }
    return { room, role };
  }

  /** An Offer of this organisation, or concealed. */
  function offerFor(req, res, need) {
    const found = offers.byId(req.params.id);
    const o = found && found.orgId === req.org.id ? found : null;
    if (!o) {
      notFound(res, 'club');
      return null;
    }
    const problems = offerIntegrity(o, { orgId: req.org.id });
    if (problems.length) {
      console.error(`OFFER integrity ${o.id}: ${problems.join(',')}`);
      err(res, 'OFFER_STATE_UNKNOWN', 'This Offer cannot be read.');
      return null;
    }
    const room = caseOfOrg(o.caseId, req.org.id);
    if (!room || !room.room) {
      notFound(res, 'club');
      return null;
    }
    if (o.playerId !== room.playerId) {
      console.error(`OFFER integrity ${o.id}: player_mismatch`);
      err(res, 'OFFER_STATE_UNKNOWN', 'This Offer cannot be read.');
      return null;
    }
    const consistency = offerCaseConsistency(o, room, now(req));
    if (offerCaseCorrupt(consistency)) {
      console.error(`OFFER consistency ${o.id}: ${consistency.join(',')}`);
      err(res, 'OFFER_STATE_UNKNOWN', 'This Offer cannot be read.');
      return null;
    }
    const role = roleFor(req, room);
    if (!roomCan(role, need)) {
      err(
        res,
        'OFFER_NOT_PERMITTED',
        need === 'offer_view'
          ? 'Your role cannot read Offers on this case.'
          : 'Only a room lead or recruitment lead can draft, issue or withdraw an Offer.',
      );
      return null;
    }
    return { offer: o, room, role };
  }

  const offersOfCase = (kase) => offers.forCase(kase.id).filter((o) => o.orgId === kase.orgId);
  const liveOfferOf = (kase, at) =>
    offersOfCase(kase).find((o) => ['DRAFT', 'ISSUED'].includes(offerStatus(o, at))) ?? null;
  const subjectRemoved = (kase) => !!kase.subjectRemovedAt || !findPlayer(kase.playerId);

  /** The recipient rule, re-derived now rather than trusted from the record. */
  function recipientFor(org, playerId, at) {
    const r = resolveContactRecipient({
      player: findPlayer(playerId),
      org,
      guardians: guardians.forPlayer(playerId),
      isAdult,
      visibleToOrg,
      isBlocked,
      now: new Date(at),
    });
    if (r.ok) return r;
    const error = r.error === 'CONTACT_BLOCKED' ? 'OFFER_BLOCKED' : 'OFFER_RECIPIENT_INVALID';
    return {
      ok: false,
      error,
      message:
        error === 'OFFER_BLOCKED'
          ? 'This player (or their guardian) has blocked your organisation.'
          : r.error === 'CONTACT_GUARDIAN_REQUIRED'
            ? 'This player is under the age of majority and no valid guardian route exists.'
            : r.message,
    };
  }

  /**
   * `expectedRev` is required on every club mutation of an existing Offer and is never coerced. There is one
   * rev, the Offer's: every revision change and every recipient answer moves it.
   */
  function revGate(req, res, record) {
    const exp = expectedRevOf(req.body);
    if (exp === null) {
      err(res, 'OFFER_REV_REQUIRED', 'expectedRev is required: send the rev you were looking at.');
      return false;
    }
    const rawRev = req.body?.expectedRev ?? req.body?.expectedVersion;
    if (!Number.isInteger(rawRev) || rawRev < 0) {
      err(res, 'OFFER_REV_REQUIRED', 'expectedRev must be a non-negative integer.', {
        field: 'expectedRev',
        expected: 'integer',
      });
      return false;
    }
    return guardRev(req, res, record, {
      errorCode: 'OFFER_REV_CONFLICT',
      current: { rev: Number.isInteger(record.rev) ? record.rev : 1, status: record.status },
    });
  }

  function resolveDocuments(refs, orgId) {
    const out = [];
    for (const d of refs) {
      const ev = vaultRecord(d.evidenceId);
      if (!ev || ev.orgId !== orgId)
        return {
          ok: false,
          error: 'OFFER_DOCUMENT_INVALID',
          field: 'documents',
          message: 'No evidence record of yours matches that reference.',
        };
      out.push({
        id: nextId('rofd'),
        evidenceId: ev.id,
        label: d.label ?? ev.filename ?? null,
        mime: ev.mime ?? null,
        bytes: ev.bytes ?? null,
      });
    }
    return { ok: true, documents: out };
  }

  /** Blocker codes for the screen; the mutation checks them again. */
  function blockersFor(kase, role, at, { forIssue = false, offer = null } = {}) {
    const blockers = [];
    const status = kase.room?.status ?? null;
    if (!roomCan(role, 'offer_draft')) blockers.push('OFFER_ROLE');
    if (subjectRemoved(kase)) blockers.push('SUBJECT_REMOVED');
    if (isBlocked(kase.playerId, kase.orgId)) blockers.push('BLOCKED');
    if (!forIssue) {
      if (status !== 'offer_consideration') blockers.push('CASE_STATE');
      const dp = evidenceProvider().check('decision_progress', { kase, now: at });
      if (dp?.satisfied !== true) blockers.push('DECISION_REQUIRED');
      if (liveOfferOf(kase, at)) blockers.push('OFFER_LIVE');
    } else {
      if (!['offer_consideration', 'offer_made'].includes(status)) blockers.push('CASE_STATE');
      const rec = recipientFor(orgOf(kase.orgId) ?? { id: kase.orgId }, kase.playerId, at);
      if (!rec.ok) blockers.push(rec.error === 'OFFER_BLOCKED' ? 'BLOCKED' : 'RECIPIENT');
      else if (rec.recipient.minor && !minorOfferPathwayOpen(orgOf(kase.orgId)?.country ?? 'GB'))
        blockers.push('MINOR_PATHWAY_CLOSED');
      if (offer?.transactionId) {
        const r =
          transactions?.offerReadinessFor?.(offer.transactionId, { orgId: kase.orgId, caseId: kase.id }) ?? null;
        if (!r) blockers.push('TRANSACTION_MISSING');
        else if (!r.readiness.canStartOfferWorkflow) blockers.push('TRANSACTION_NOT_READY');
      }
    }
    return [...new Set(blockers)];
  }

  // ------------------------------------------------------- lifecycle coupling

  /** Validate with the real evidence provider, then write through the lifecycle writer. Never throws. */
  function advanceCase({ req = null, room, action, at, trigger, actor = null, keyDetail = {} }) {
    const role = req && !actor ? roleFor(req, room) : 'recruitment_admin';
    const verdict = canTransitionRecruitmentCase(room, action, { role, evidence: evidenceProvider(), now: at });
    if (verdict.ok) {
      const org = orgOf(room.orgId);
      let effect;
      try {
        effect = ctx.applyLifecycleTransition({
          req,
          room,
          to: verdict.to,
          reasonCodes: [],
          trigger,
          actor: actor ? { ...actor, org } : null,
          statusDetail: {
            lifecycleAction: action,
            clientKey: null,
            policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION,
            ...keyDetail,
          },
        });
      } catch (e) {
        console.error(`OFFER lifecycle_writer_threw ${action}: ${e?.message ?? e}`);
        return {
          applied: false,
          action,
          reason: 'writer_failed',
          message: null,
          allowed: [],
          from: room.room.status,
          to: null,
          at,
        };
      }
      const { from, to } = effect;
      return { applied: true, action, from, to, at };
    }
    if (verdict.error === 'LIFECYCLE_NO_CHANGE')
      return { applied: false, action, reason: 'already_there', from: room.room.status, to: room.room.status, at };
    return {
      applied: false,
      action,
      reason: verdict.error,
      message: verdict.message ?? null,
      allowed: verdict.allowed ?? [],
      from: room.room.status,
      to: null,
      at,
    };
  }

  // ------------------------------------------------------------ notifications

  function notifyClub(offer, text) {
    const room = recruitmentReads.cases.byId(offer.caseId);
    const ids = new Set(
      [room?.ownerUserId, room?.room?.leadScoutUserId, currentRevision(offer)?.issuedBy?.id].filter(Boolean),
    );
    for (const uid of ids) notify({ kind: 'org_user', id: uid }, 'recruitment_offer', text, offer.id);
  }
  function notifyRecipient(rev, text, offerId) {
    const snap = rev?.recipientSnapshot;
    if (!snap) return;
    if (snap.type === 'guardian' && snap.guardianId)
      notify({ kind: 'guardian', id: snap.guardianId }, 'recruitment_offer', text, offerId);
    else notify({ kind: 'player', id: snap.playerId }, 'recruitment_offer', text, offerId);
  }
  /** Only while the client has shared the Offer and the agent basis still holds. */
  function notifyAgent(offer, text) {
    const s = offer.agentShare;
    if (!s?.agentUserId) return;
    const basis = integration?.basisFor?.({ agentUserId: s.agentUserId, clientId: offer.playerId, at: now() });
    if (basis?.ok) notify({ kind: 'org_user', id: s.agentUserId }, 'recruitment_offer', text, offer.id);
  }

  // ================================================================== club

  orgRouter.get('/rooms/:id/offers', (req, res) => {
    const got = roomFor(req, res, 'offer_view');
    if (!got) return;
    const { room: kase, role } = got;
    const at = now(req);
    const offers = offersOfCase(kase)
      .map((o) => ({
        ...clubView(o, at),
        integrity: [...offerIntegrity(o, { orgId: kase.orgId, caseId: kase.id }), ...offerCaseConsistency(o, kase, at)],
      }))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const live = liveOfferOf(kase, at);
    res.json({
      offers,
      liveOfferId: live?.id ?? null,
      requirements: {
        role,
        canDraft: roomCan(role, 'offer_draft'),
        canIssue: roomCan(role, 'offer_issue'),
        status: kase.room?.status ?? null,
        statusLabel: ROOM_STATUS_LABELS[kase.room?.status] ?? null,
        draftBlockers: blockersFor(kase, role, at),
        issueBlockers:
          live && offerStatus(live, at) === 'DRAFT' ? blockersFor(kase, role, at, { forIssue: true, offer: live }) : [],
        blocked: isBlocked(kase.playerId, kase.orgId),
        subjectRemoved: subjectRemoved(kase),
      },
      vocabulary: {
        statuses: OFFER_STATUSES,
        statusLabels: { ...OFFER_STATUS_LABELS },
        types: OFFER_TYPES,
        responseTypes: OFFER_RESPONSE_TYPES,
      },
      limits: { ...OFFER_LIMITS },
      policyVersion: OFFER_POLICY_VERSION,
      note: "An Offer is created only by an explicit act here. A positive recruitment decision opens the door; it never walks through it. Issuing an Offer moves the case to Offer made; the recipient's own acceptance or decline moves it on. Nothing here is a signing.",
    });
  });

  orgRouter.post('/rooms/:id/offers', (req, res) => {
    const got = roomFor(req, res, 'offer_draft');
    if (!got) return;
    const { room: kase, role } = got;
    const at = now(req);
    const key = normaliseOfferClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const terms = validateTerms(req.body?.terms);
    if (!terms.ok)
      return err(res, terms.error, terms.message, {
        field: terms.field,
        ...(terms.allowed ? { allowed: terms.allowed } : {}),
        ...(terms.expected ? { expected: terms.expected } : {}),
      });
    const msgs = validateMessages(req.body ?? {});
    if (!msgs.ok) return err(res, msgs.error, msgs.message, { field: msgs.field });
    const expiry = validateExpiry(req.body?.expiresAt, { now: at });
    if (!expiry.ok)
      return err(res, expiry.error, expiry.message, {
        field: 'expiresAt',
        ...(expiry.expected ? { expected: expiry.expected } : {}),
      });
    const docRefs = validateDocumentRefs(req.body?.documents);
    if (!docRefs.ok) return err(res, docRefs.error, docRefs.message, { field: 'documents' });
    const fp = payloadFingerprint({
      terms: terms.terms,
      recipientMessage: msgs.recipientMessage,
      internalNote: msgs.internalNote,
      expiresAt: expiry.ms,
      documents: (docRefs.documents ?? []).map((d) => d.evidenceId),
    });
    if (key.key) {
      const prior = offersOfCase(kase).find((o) => o.keys?.create?.key === key.key);
      if (prior) {
        if (prior.keys.create.fp === fp) return res.json({ offer: clubView(prior, at), idempotent: true });
        return err(res, 'OFFER_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different Offer.');
      }
    }
    if (subjectRemoved(kase))
      return err(
        res,
        'OFFER_SUBJECT_REMOVED',
        'This player removed their ScoutBox account. No Offer is written about a person who left.',
      );
    if (isBlocked(kase.playerId, kase.orgId))
      return err(
        res,
        'OFFER_BLOCKED',
        'This player (or their guardian) has blocked your organisation. No Offer is drafted while the block stands.',
      );
    if (kase.room?.status !== 'offer_consideration')
      return err(
        res,
        'OFFER_STATE_INVALID',
        `An Offer is drafted from Offer consideration; this case is at "${ROOM_STATUS_LABELS[kase.room?.status] ?? kase.room?.status}".`,
        { current: { status: kase.room?.status ?? null } },
      );
    const dp = evidenceProvider().check('decision_progress', { kase, now: at });
    if (dp?.satisfied !== true)
      return err(
        res,
        'OFFER_ISSUE_NOT_ALLOWED',
        'A finalized recruitment decision to progress must stand on this case before an Offer is drafted.',
        { reasons: ['DECISION_REQUIRED'] },
      );
    const live = liveOfferOf(kase, at);
    if (live)
      return err(
        res,
        'OFFER_STATE_INVALID',
        'This case already has a live Offer. Edit, issue or withdraw it; a changed Offer is a new revision, not a second Offer.',
        { current: { offerId: live.id, status: offerStatus(live, at) } },
      );
    if (limited('offer_draft_write', req.org.id)) return res.status(429).json(rateLimitedBody('offer_draft_write'));
    let transactionId = null;
    if (
      !(req.body?.transactionId === undefined || req.body?.transactionId === null || req.body?.transactionId === '')
    ) {
      if (typeof req.body.transactionId !== 'string')
        return err(res, 'OFFER_INPUT_INVALID', 'transactionId must be text.', { field: 'transactionId' });
      const r =
        transactions?.offerReadinessFor?.(req.body.transactionId, { orgId: kase.orgId, caseId: kase.id }) ?? null;
      if (!r)
        return err(
          res,
          'OFFER_INPUT_INVALID',
          'No transaction workspace of yours for this case matches that reference.',
          { field: 'transactionId' },
        );
      transactionId = r.tx.id;
    }
    const docs = resolveDocuments(docRefs.documents ?? [], kase.orgId);
    if (!docs.ok) return err(res, docs.error, docs.message, { field: docs.field });
    if (
      msgs.recipientMessage &&
      !moderateOrRefuse(res, msgs.recipientMessage, {
        kind: 'recruitment_offer',
        orgId: req.org.id,
        userId: req.orgUser.id,
      })
    )
      return;
    const by = byOrg(req);
    const rev = {
      id: nextId('rofr'),
      revisionNumber: 1,
      status: 'DRAFT',
      terms: terms.terms,
      recipientMessage: msgs.recipientMessage,
      internalNote: msgs.internalNote,
      documents: docs.documents,
      expiresAt: expiry.ms,
      createdAt: at,
      createdBy: by,
      updatedAt: at,
      updatedBy: by,
      issuedAt: null,
      issuedBy: null,
      withdrawnAt: null,
      withdrawnBy: null,
      withdrawReason: null,
      respondedAt: null,
      response: null,
      supersedesRevisionId: null,
      supersededByRevisionId: null,
      supersededAt: null,
      recipientSnapshot: null,
      readinessSnapshot: null,
      rev: 1,
      revAt: at,
      revBy: null,
    };
    const offer = {
      id: nextId('rof'),
      orgId: kase.orgId,
      caseId: kase.id,
      playerId: kase.playerId,
      type: terms.terms.offerType,
      decisionId: dp.sourceId ?? null,
      transactionId,
      status: 'DRAFT',
      currentRevisionId: rev.id,
      revisions: [rev],
      responses: [],
      readReceipts: [],
      agentShare: null,
      keys: { create: key.key ? { key: key.key, fp } : null, issue: [], withdraw: [], revise: [] },
      lifecycle: null,
      history: [entry('offer_draft_created', by, { revisionId: rev.id, revisionNumber: 1 }, at)],
      createdAt: at,
      createdBy: by,
      updatedAt: at,
      rev: 1,
      revAt: at,
      revBy: null,
      policyVersion: OFFER_POLICY_VERSION,
    };
    const stored = unit(() => {
      const fresh = offers.create(offer);
      caseAudit(kase, 'org', req.orgUser.id, req.orgUser.name, 'offer_draft_created', {
        offerId: offer.id,
        revisionId: rev.id,
      });
      return fresh;
    });
    safe('offer_draft_created', () =>
      broadcast?.('offer_draft_created', { orgId: kase.orgId, roomId: kase.id, offerId: offer.id }),
    );
    res.status(201).json({ offer: clubView(stored, at) });
  });

  orgRouter.get('/offers/:id', (req, res) => {
    const got = offerFor(req, res, 'offer_view');
    if (!got) return;
    res.json({ offer: clubView(got.offer, now(req)) });
  });

  orgRouter.get('/offers/:id/history', (req, res) => {
    const got = offerFor(req, res, 'offer_view');
    if (!got) return;
    res.json({ items: offerHistoryView(got.offer).slice(-OFFER_LIMITS.historyPage), offerId: got.offer.id });
  });

  orgRouter.patch('/offers/:id/draft', (req, res) => {
    const got = offerFor(req, res, 'offer_draft');
    if (!got) return;
    const { offer, room: kase } = got;
    const at = now(req);
    const rev = currentRevision(offer);
    if (effectiveRevisionStatus(rev, at) !== 'DRAFT')
      return err(
        res,
        'OFFER_STATE_INVALID',
        'Only a draft revision can be edited. Issued terms are immutable; open a new revision to change them.',
        { current: { status: effectiveRevisionStatus(rev, at) } },
      );
    if (subjectRemoved(kase))
      return err(
        res,
        'OFFER_SUBJECT_REMOVED',
        'This player removed their ScoutBox account. The draft can no longer be changed.',
      );
    const b = req.body ?? {};
    const terms = b.terms !== undefined ? validateTerms(b.terms) : null;
    if (terms && !terms.ok)
      return err(res, terms.error, terms.message, {
        field: terms.field,
        ...(terms.allowed ? { allowed: terms.allowed } : {}),
        ...(terms.expected ? { expected: terms.expected } : {}),
      });
    const msgs = validateMessages({
      recipientMessage: b.recipientMessage !== undefined ? b.recipientMessage : rev.recipientMessage,
      internalNote: b.internalNote !== undefined ? b.internalNote : rev.internalNote,
    });
    if (!msgs.ok) return err(res, msgs.error, msgs.message, { field: msgs.field });
    const expiry = b.expiresAt !== undefined ? validateExpiry(b.expiresAt, { now: at }) : null;
    if (expiry && !expiry.ok)
      return err(res, expiry.error, expiry.message, {
        field: 'expiresAt',
        ...(expiry.expected ? { expected: expiry.expected } : {}),
      });
    const docRefs = validateDocumentRefs(b.documents);
    if (!docRefs.ok) return err(res, docRefs.error, docRefs.message, { field: 'documents' });
    if (!revGate(req, res, offer)) return;
    if (limited('offer_draft_write', req.org.id)) return res.status(429).json(rateLimitedBody('offer_draft_write'));
    let docs = null;
    if (docRefs.documents !== undefined) {
      docs = resolveDocuments(docRefs.documents, kase.orgId);
      if (!docs.ok) return err(res, docs.error, docs.message, { field: docs.field });
    }
    if (
      b.recipientMessage !== undefined &&
      msgs.recipientMessage &&
      !moderateOrRefuse(res, msgs.recipientMessage, {
        kind: 'recruitment_offer',
        orgId: req.org.id,
        userId: req.orgUser.id,
      })
    )
      return;
    const by = byOrg(req);
    const stored = unit(() =>
      offers.editDraft(
        offer.id,
        {
          revisionId: rev.id,
          at,
          by,
          terms: terms ? terms.terms : rev.terms,
          recipientMessage: msgs.recipientMessage,
          internalNote: msgs.internalNote,
          expiresAt: expiry ? expiry.ms : rev.expiresAt,
          documents: docs ? docs.documents : undefined,
        },
        {
          at,
          revBy: req.orgUser,
          touch: true,
          bump: true,
          bumpRevisionId: rev.id,
          history: [entry('offer_draft_updated', by, { revisionId: rev.id }, at)],
        },
      ),
    );
    safe('offer_draft_updated', () =>
      broadcast?.('offer_draft_updated', { orgId: kase.orgId, roomId: kase.id, offerId: offer.id }),
    );
    res.json({ offer: clubView(stored, at) });
  });

  /**
   * Everything is re-resolved at issue: role, ownership, state, rev, subject, block, recipient (adult,
   * guardian route, minor pathway), transaction readiness, expiry and document ownership. The revision and
   * the case move persist together or not at all.
   */
  orgRouter.post('/offers/:id/issue', (req, res) => {
    const got = offerFor(req, res, 'offer_issue');
    if (!got) return;
    const { offer, room: kase, role } = got;
    const at = now(req);
    const key = normaliseOfferClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const rev = currentRevision(offer);
    const usedIssue = key.key ? keyRow(offer, 'issue', key.key) : null;
    if (usedIssue) {
      if (usedIssue.revisionId === rev.id)
        return res.json({ offer: clubView(offer, at), lifecycle: offer.lifecycle ?? null, idempotent: true });
      return err(res, 'OFFER_IDEMPOTENCY_CONFLICT', 'This clientKey was already used to issue a different revision.');
    }
    const st = effectiveRevisionStatus(rev, at);
    if (st !== 'DRAFT')
      return err(
        res,
        'OFFER_STATE_INVALID',
        st === 'ISSUED' ? 'This revision is already issued.' : 'Only a draft revision can be issued.',
        { current: { status: st } },
      );
    const liveNow = liveStatus(offer, at);
    if (liveNow === 'ACCEPTED')
      return err(
        res,
        'OFFER_STATE_INVALID',
        'The recipient accepted the revision that is out. A new revision is not issued over an acceptance.',
        { current: { status: liveNow } },
      );
    if (!revGate(req, res, offer)) return;
    if (subjectRemoved(kase))
      return err(
        res,
        'OFFER_SUBJECT_REMOVED',
        'This player removed their ScoutBox account. No Offer is issued to a person who left.',
      );
    if (isBlocked(kase.playerId, kase.orgId))
      return err(
        res,
        'OFFER_BLOCKED',
        'This player (or their guardian) has blocked your organisation. An Offer is not issued while the block stands.',
      );
    if (!['offer_consideration', 'offer_made'].includes(kase.room?.status))
      return err(
        res,
        'OFFER_LIFECYCLE_CONFLICT',
        `The case at "${ROOM_STATUS_LABELS[kase.room?.status] ?? kase.room?.status}" cannot take an issued Offer.`,
        { current: { status: kase.room?.status ?? null } },
      );
    const terms = validateTerms(rev.terms, { requireComplete: true });
    if (!terms.ok) return err(res, terms.error, terms.message, { field: terms.field });
    const expiry = validateExpiry(rev.expiresAt, { now: at, required: true });
    if (!expiry.ok) return err(res, expiry.error, expiry.message, { field: 'expiresAt' });
    // Documents named at draft time must still be this organisation's.
    for (const d of rev.documents ?? []) {
      const ev = vaultRecord(d.evidenceId);
      if (!ev || ev.orgId !== kase.orgId)
        return err(res, 'OFFER_DOCUMENT_INVALID', 'A document on this draft no longer belongs to your organisation.', {
          field: 'documents',
        });
    }
    // The recipient resolved now; the minor pathway is closed in this build.
    const org = orgOf(kase.orgId) ?? { id: kase.orgId };
    const rec = recipientFor(org, kase.playerId, at);
    if (!rec.ok) return err(res, rec.error, rec.message);
    if (rec.recipient.minor && !minorOfferPathwayOpen(org.country ?? 'GB')) {
      return err(
        res,
        'OFFER_RECIPIENT_INVALID',
        'This player is under the age of majority. No jurisdiction policy for an Offer to a minor is encoded in this build, so the Offer is not issued.',
        { reasons: ['MINOR_PATHWAY_CLOSED'] },
      );
    }
    // Transaction readiness re-evaluated now, not from the draft's snapshot.
    let readiness = null;
    if (offer.transactionId) {
      const r = transactions?.offerReadinessFor?.(offer.transactionId, { orgId: kase.orgId, caseId: kase.id }) ?? null;
      if (!r)
        return err(
          res,
          'OFFER_COMPLIANCE_BLOCKED',
          'The transaction workspace this Offer references is no longer available to you.',
          { blockers: ['TRANSACTION_MISSING'] },
        );
      if (!r.readiness.canStartOfferWorkflow)
        return err(res, 'OFFER_COMPLIANCE_BLOCKED', 'The transaction workspace does not currently permit an Offer.', {
          blockers: r.readiness.blockers,
        });
      readiness = { transactionId: r.tx.id, evaluatedAt: at, status: r.tx.status, blockers: [] };
    }
    if (limited('offer_issue', req.org.id)) return res.status(429).json(rateLimitedBody('offer_issue'));

    // One unit: a case that cannot take the step rolls the Offer back with it.
    const by = byOrg(req);
    const prevIssued =
      (offer.revisions ?? []).find((r) => r.id === rev.supersedesRevisionId && r.status === 'ISSUED') ?? null;
    let moved = null;
    const done = inUnit(res, () => {
      offers.issueRevision(offer.id, {
        revisionId: rev.id,
        at,
        by,
        terms: terms.terms,
        readinessSnapshot: readiness,
        supersedesRevisionId: prevIssued?.id ?? null,
        recipientSnapshot: {
          type: rec.recipient.type,
          playerId: rec.recipient.playerId,
          guardianId: rec.recipient.guardianId ?? null,
          minor: rec.recipient.minor === true,
          at,
        },
      });
      moved = advanceCase({
        req,
        room: kase,
        action: 'sendOffer',
        at,
        trigger: `offer:issue:${offer.id}`,
        keyDetail: { offerId: offer.id, revisionId: rev.id },
      });
      if (!moved.applied && moved.reason !== 'already_there') {
        throw new OfferRefusal({
          error: 'OFFER_LIFECYCLE_CONFLICT',
          message:
            `The case at "${ROOM_STATUS_LABELS[moved.from] ?? moved.from}" cannot take the step an issued Offer asks for (sendOffer). ${moved.message ?? ''}`.trim(),
          lifecycle: moved.reason,
          allowed: moved.allowed ?? [],
          current: { status: moved.from },
        });
      }
      const history = [
        entry(
          prevIssued ? 'offer_superseded' : 'offer_issued',
          by,
          {
            revisionId: rev.id,
            revisionNumber: rev.revisionNumber,
            supersedes: prevIssued?.id ?? null,
            expiresAt: rev.expiresAt,
          },
          at,
        ),
      ];
      if (prevIssued)
        history.push(
          entry(
            'offer_issued',
            by,
            { revisionId: rev.id, revisionNumber: rev.revisionNumber, expiresAt: rev.expiresAt },
            at,
          ),
        );
      const fresh = offers.recordAct(offer.id, {
        at,
        revBy: req.orgUser,
        touch: true,
        bump: true,
        bumpRevisionId: rev.id,
        lifecycle: moved,
        key: key.key ? { act: 'issue', key: key.key, revisionId: rev.id } : null,
        history,
      });
      caseAudit(kase, 'org', req.orgUser.id, req.orgUser.name, prevIssued ? 'offer_superseded' : 'offer_issued', {
        offerId: offer.id,
        revisionId: rev.id,
        supersedes: prevIssued?.id ?? null,
        to: moved.applied ? moved.to : undefined,
      });
      return fresh;
    });
    if (!done) return;
    const issued = done.value;
    const issuedRev = currentRevision(issued);
    if (prevIssued)
      safe('offer_superseded', () =>
        broadcast?.('offer_superseded', { orgId: kase.orgId, roomId: kase.id, offerId: offer.id }),
      );
    safe('offer_issued', () => broadcast?.('offer_issued', { orgId: kase.orgId, roomId: kase.id, offerId: offer.id }));
    safe('notify', () =>
      notifyRecipient(
        issuedRev,
        `${org.name ?? 'A club'} has issued you an Offer${prevIssued ? ' (a revised one)' : ''}. Read the exact terms in ScoutBox and answer before it expires. Accepting is not a signing.`,
        offer.id,
      ),
    );
    safe('notifyAgent', () =>
      notifyAgent(
        issued,
        `Your client ${kase.playerName ?? ''} received a${prevIssued ? ' revised' : 'n'} Offer from ${org.name ?? 'a club'}. Their answer is their own act.`.replace(
          /\s+/g,
          ' ',
        ),
      ),
    );
    for (const uid of new Set([kase.ownerUserId, kase.room?.leadScoutUserId])) {
      if (!uid || uid === req.orgUser.id) continue;
      safe('notifyClub', () =>
        notify(
          { kind: 'org_user', id: uid },
          'recruitment_offer',
          `Recruitment Room — ${kase.playerName ?? 'a removed player'}: Offer revision ${rev.revisionNumber} issued.`,
          offer.id,
        ),
      );
    }
    res.json({
      offer: clubView(issued, at),
      lifecycle: moved,
      case: moved.applied ? { from: moved.from, to: moved.to } : { unchanged: true, status: kase.room.status },
      rev: kase.room.rev,
    });
  });

  orgRouter.post('/offers/:id/withdraw', (req, res) => {
    const got = offerFor(req, res, 'offer_issue');
    if (!got) return;
    const { offer, room: kase } = got;
    const at = now(req);
    const key = normaliseOfferClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const rev = currentRevision(offer);
    const usedWithdraw = key.key ? keyRow(offer, 'withdraw', key.key) : null;
    if (usedWithdraw) {
      if (usedWithdraw.revisionId === rev.id)
        return res.json({ offer: clubView(offer, at), lifecycle: offer.lifecycle ?? null, idempotent: true });
      return err(
        res,
        'OFFER_IDEMPOTENCY_CONFLICT',
        'This clientKey was already used to withdraw a different revision.',
      );
    }
    const w = canWithdrawRevision(offer, at);
    if (!w.ok) return err(res, w.error, w.message, w.current ? { current: w.current } : {});
    const reasonRaw = req.body?.reason;
    if (
      reasonRaw !== undefined &&
      reasonRaw !== null &&
      (typeof reasonRaw !== 'string' || reasonRaw.length > OFFER_LIMITS.withdrawReason)
    )
      return err(res, 'OFFER_INPUT_INVALID', `A reason is text under ${OFFER_LIMITS.withdrawReason} characters.`, {
        field: 'reason',
      });
    const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : null;
    if (!revGate(req, res, offer)) return;
    // A block does not stop a withdrawal: it closes the Offer and does not approach the recipient.
    if (limited('offer_withdraw', req.org.id)) return res.status(429).json(rateLimitedBody('offer_withdraw'));
    const by = byOrg(req);
    const wasIssued = w.from === 'ISSUED';
    // Withdrawing an issued Offer steps the case back to Offer consideration: the decision still stands.
    let moved = { applied: false, action: null, reason: 'draft', from: kase.room.status, to: kase.room.status, at };
    const withdrawn = unit(() => {
      offers.withdrawRevision(offer.id, { revisionId: rev.id, at, by, reason });
      if (wasIssued && kase.room?.status === 'offer_made')
        moved = advanceCase({
          req,
          room: kase,
          action: 'considerOffer',
          at,
          trigger: `offer:withdraw:${offer.id}`,
          keyDetail: { offerId: offer.id, revisionId: rev.id },
        });
      const fresh = offers.recordAct(offer.id, {
        at,
        revBy: req.orgUser,
        touch: true,
        bump: true,
        bumpRevisionId: rev.id,
        lifecycle: moved,
        key: key.key ? { act: 'withdraw', key: key.key, revisionId: rev.id } : null,
        history: [entry('offer_withdrawn', by, { revisionId: rev.id, wasIssued, hadReason: !!reason }, at)],
      });
      caseAudit(kase, 'org', req.orgUser.id, req.orgUser.name, 'offer_withdrawn', {
        offerId: offer.id,
        revisionId: rev.id,
        wasIssued,
        to: moved.applied ? moved.to : undefined,
      });
      return fresh;
    });
    safe('offer_withdrawn', () =>
      broadcast?.('offer_withdrawn', { orgId: kase.orgId, roomId: kase.id, offerId: offer.id }),
    );
    if (wasIssued) {
      safe('notify', () =>
        notifyRecipient(
          currentRevision(withdrawn),
          `${orgOf(kase.orgId)?.name ?? 'The club'} has withdrawn its Offer. Nothing further is needed from you.`,
          offer.id,
        ),
      );
      safe('notifyAgent', () =>
        notifyAgent(
          withdrawn,
          `The Offer to your client ${kase.playerName ?? ''} was withdrawn by the club.`.replace(/\s+/g, ' '),
        ),
      );
    }
    res.json({ offer: clubView(withdrawn, at), lifecycle: moved });
  });

  orgRouter.post('/offers/:id/revise', (req, res) => {
    const got = offerFor(req, res, 'offer_draft');
    if (!got) return;
    const { offer, room: kase } = got;
    const at = now(req);
    const key = normaliseOfferClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const usedRevise = key.key ? keyRow(offer, 'revise', key.key) : null;
    if (usedRevise && (offer.revisions ?? []).some((r) => r.id === usedRevise.revisionId))
      return res.json({ offer: clubView(offer, at), idempotent: true });
    const c = canRevise(offer, at);
    if (!c.ok) return err(res, c.error, c.message ?? 'This Offer cannot be revised.');
    if (subjectRemoved(kase))
      return err(
        res,
        'OFFER_SUBJECT_REMOVED',
        'This player removed their ScoutBox account. No new revision is written.',
      );
    if (isBlocked(kase.playerId, kase.orgId))
      return err(
        res,
        'OFFER_BLOCKED',
        'This player (or their guardian) has blocked your organisation. No new revision is drafted while the block stands.',
      );
    if (!['offer_consideration', 'offer_made'].includes(kase.room?.status))
      return err(
        res,
        'OFFER_LIFECYCLE_CONFLICT',
        `The case at "${ROOM_STATUS_LABELS[kase.room?.status] ?? kase.room?.status}" cannot take a new Offer revision.`,
        { current: { status: kase.room?.status ?? null } },
      );
    const prev = currentRevision(offer);
    if (!revGate(req, res, offer)) return;
    const b = req.body ?? {};
    const terms = validateTerms(b.terms !== undefined ? b.terms : prev.terms);
    if (!terms.ok) return err(res, terms.error, terms.message, { field: terms.field });
    const msgs = validateMessages({
      recipientMessage: b.recipientMessage !== undefined ? b.recipientMessage : prev.recipientMessage,
      internalNote: b.internalNote !== undefined ? b.internalNote : prev.internalNote,
    });
    if (!msgs.ok) return err(res, msgs.error, msgs.message, { field: msgs.field });
    const expiry = validateExpiry(b.expiresAt !== undefined ? b.expiresAt : null, { now: at });
    if (!expiry.ok) return err(res, expiry.error, expiry.message, { field: 'expiresAt' });
    const docRefs = validateDocumentRefs(b.documents);
    if (!docRefs.ok) return err(res, docRefs.error, docRefs.message, { field: 'documents' });
    if (limited('offer_draft_write', req.org.id)) return res.status(429).json(rateLimitedBody('offer_draft_write'));
    let docs = { ok: true, documents: (prev.documents ?? []).map((d) => ({ ...d, id: nextId('rofd') })) };
    if (docRefs.documents !== undefined) {
      docs = resolveDocuments(docRefs.documents, kase.orgId);
      if (!docs.ok) return err(res, docs.error, docs.message, { field: docs.field });
    }
    if (
      b.recipientMessage !== undefined &&
      msgs.recipientMessage &&
      !moderateOrRefuse(res, msgs.recipientMessage, {
        kind: 'recruitment_offer',
        orgId: req.org.id,
        userId: req.orgUser.id,
      })
    )
      return;
    const by = byOrg(req);
    const rev = {
      id: nextId('rofr'),
      revisionNumber: nextRevisionNumber(offer),
      status: 'DRAFT',
      terms: terms.terms,
      recipientMessage: msgs.recipientMessage,
      internalNote: msgs.internalNote,
      documents: docs.documents,
      expiresAt: expiry.ms,
      createdAt: at,
      createdBy: by,
      updatedAt: at,
      updatedBy: by,
      issuedAt: null,
      issuedBy: null,
      withdrawnAt: null,
      withdrawnBy: null,
      withdrawReason: null,
      respondedAt: null,
      response: null,
      supersedesRevisionId: c.from === 'ISSUED' ? prev.id : null,
      supersededByRevisionId: null,
      supersededAt: null,
      recipientSnapshot: null,
      readinessSnapshot: null,
      rev: 1,
      revAt: at,
      revBy: null,
    };
    const revised = unit(() => {
      const fresh = offers.addRevision(
        offer.id,
        { revision: rev },
        {
          at,
          revBy: req.orgUser,
          touch: true,
          bump: true,
          key: key.key ? { act: 'revise', key: key.key, revisionId: rev.id } : null,
          history: [
            entry(
              'offer_draft_created',
              by,
              { revisionId: rev.id, revisionNumber: rev.revisionNumber, supersedes: rev.supersedesRevisionId },
              at,
            ),
          ],
        },
      );
      caseAudit(kase, 'org', req.orgUser.id, req.orgUser.name, 'offer_draft_created', {
        offerId: offer.id,
        revisionId: rev.id,
        revises: prev.id,
      });
      return fresh;
    });
    safe('offer_draft_created', () =>
      broadcast?.('offer_draft_created', { orgId: kase.orgId, roomId: kase.id, offerId: offer.id }),
    );
    res.status(201).json({ offer: clubView(revised, at) });
  });

  orgRouter.get('/recruitment/offer-policy', (_req, res) => {
    res.json({
      policyVersion: OFFER_POLICY_VERSION,
      statuses: OFFER_STATUSES,
      statusLabels: { ...OFFER_STATUS_LABELS },
      types: OFFER_TYPES,
      responseTypes: OFFER_RESPONSE_TYPES,
      limits: { ...OFFER_LIMITS },
      minorPathway: { ...MINOR_OFFER_PATHWAY_ENABLED },
      lifecycle: {
        issue: 'offer_made',
        accept: 'offer_accepted',
        decline: 'offer_declined',
        withdraw: 'offer_consideration',
      },
      note: "A recruitment decision authorises considering an Offer and creates none. Only an issued revision reaches Offer made; only the recipient's own act reaches accepted or declined; an acceptance is not a signing and P6 writes no signing.",
    });
  });

  // ================================================================== recipient

  /**
   * Shown to a recipient or agent only if the row is sound and its case does not contradict it; otherwise
   * omitted, never repaired.
   */
  function soundOffer(o, at) {
    if (!o || offerIntegrity(o).length) return false;
    const k = caseOfOrg(o.caseId, o.orgId);
    if (!k) return true;
    if (k.playerId !== o.playerId) {
      console.error(`OFFER integrity ${o.id}: player_mismatch`);
      return false;
    }
    const c = offerCaseConsistency(o, k, at);
    if (offerCaseCorrupt(c)) {
      console.error(`OFFER consistency ${o.id}: ${c.join(',')}`);
      return false;
    }
    return true;
  }

  function recipientOffers({ by, actorId, playerIds, at }) {
    const out = [];
    for (const o of offers.forPlayers(playerIds)) {
      if (!soundOffer(o, at)) continue;
      const live = liveRevision(o);
      if (!live) continue; // never issued: invisible, not redacted
      const snap = live.recipientSnapshot;
      if (!snap || snap.type !== by) continue;
      if (by === 'guardian' && snap.guardianId !== actorId) continue;
      out.push(o);
    }
    return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  function recipientOffer(req, res, { by, actorId, playerIds }) {
    const at = now(req);
    const o = recipientOffers({ by, actorId, playerIds, at }).find((x) => x.id === req.params.id) ?? null;
    if (!o) {
      notFound(res, by);
      return null;
    }
    return o;
  }

  const caseOpenFor = (o) => {
    const k = caseOfOrg(o.caseId, o.orgId);
    return !k || k.room?.status === 'offer_made';
  };
  const recipientView = (o, at) =>
    withSigning(o, at, offerRecipientView(o, at, { orgName: orgOf(o.orgId)?.name ?? null, caseOpen: caseOpenFor(o) }));

  function receiptDue(o, { kind, id }) {
    const cur = liveRevision(o);
    return (
      !!cur &&
      !(o.readReceipts ?? []).some((r) => r && r.revisionId === cur.id && r.viewerKind === kind && r.viewerId === id)
    );
  }
  function markViewed(o, { kind, id }, at) {
    if (!receiptDue(o, { kind, id })) return o;
    const cur = liveRevision(o);
    return offers.addReadReceipt(
      o.id,
      { receipt: { revisionId: cur.id, viewerKind: kind, viewerId: id, firstViewedAt: at } },
      { history: [entry('offer_viewed', { kind, id, name: null }, { revisionId: cur.id }, at)] },
    );
  }

  function listHandler(by) {
    return (req, res) => {
      const at = now(req);
      const actorId = by === 'guardian' ? req.guardian.id : req.player.id;
      const playerIds = by === 'guardian' ? req.guardian.childIds : [req.player.id];
      // Listing shows the full terms, so it counts as the recipient's first sight of each live revision. A unit
      // is opened only when a receipt is new.
      const viewer = { kind: by, id: actorId };
      const listed = recipientOffers({ by, actorId, playerIds, at });
      const unseen = listed.filter((o) => receiptDue(o, viewer));
      const marked = unseen.length
        ? new Map(unit(() => unseen.map((o) => [o.id, markViewed(o, viewer, at)])))
        : new Map();
      const rows = listed.map((o) => marked.get(o.id) ?? o);
      const items = rows.map((o) => ({ ...recipientView(o, at), playerName: findPlayer(o.playerId)?.name ?? null }));
      res.json({
        items,
        note: 'Offers issued to you, as the club issued them. Read the exact revision; accept or decline before it expires. Accepting in ScoutBox is not a signing.',
      });
    };
  }

  function readHandler(by) {
    return (req, res) => {
      const actorId = by === 'guardian' ? req.guardian.id : req.player.id;
      const playerIds = by === 'guardian' ? req.guardian.childIds : [req.player.id];
      const o = recipientOffer(req, res, { by, actorId, playerIds });
      if (!o) return;
      const at = now(req);
      const viewer = { kind: by, id: actorId };
      const seen = receiptDue(o, viewer) ? unit(() => markViewed(o, viewer, at)) : o;
      res.json({ offer: recipientView(seen, at), history: offerHistoryView(seen, { forRecipient: true }) });
    };
  }

  /**
   * Accept or decline one exact revision, as the recipient's own act. A block allows a decline (it is a
   * closure) but not an acceptance. The case moves through the lifecycle validator with the recipient as actor.
   */
  function respondHandler(by, responseType) {
    return (req, res) => {
      const actorId = by === 'guardian' ? req.guardian.id : req.player.id;
      const actorName = by === 'guardian' ? req.guardian.name : req.player.name;
      const playerIds = by === 'guardian' ? req.guardian.childIds : [req.player.id];
      const o = recipientOffer(req, res, { by, actorId, playerIds });
      if (!o) return;
      const at = now(req);
      const key = normaliseOfferClientKey(req.body?.clientKey);
      if (!key.ok) return err(res, key.error, key.message);
      const revisionId = req.body?.revisionId;
      if (typeof revisionId !== 'string' || !revisionId)
        return err(res, 'OFFER_INPUT_INVALID', 'Name the exact revision you are answering (revisionId).', {
          field: 'revisionId',
        });
      const priorResp = key.key ? (o.responses ?? []).find((x) => x && x.clientKey === key.key) : null;
      if (priorResp) {
        if (
          priorResp.revisionId === revisionId &&
          priorResp.responseType === responseType &&
          priorResp.actorId === actorId
        )
          return res.json({ offer: recipientView(o, at), lifecycle: o.lifecycle ?? null, idempotent: true });
        return err(res, 'OFFER_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different answer.');
      }
      const player = findPlayer(o.playerId);
      const org = orgOf(o.orgId) ?? { id: o.orgId };
      const r = resolveContactRecipient({
        player,
        org,
        guardians: player ? guardians.forPlayer(player.id) : [],
        isAdult,
        visibleToOrg,
        isBlocked,
        now: new Date(at),
      });
      const blocked = !r.ok && r.error === 'CONTACT_BLOCKED';
      if (!r.ok && !blocked)
        return err(
          res,
          'OFFER_RECIPIENT_INVALID',
          by === 'guardian'
            ? 'You are no longer the verified guardian route for this player.'
            : 'This Offer is not yours to answer.',
        );
      if (!blocked) {
        if (r.recipient.type !== by)
          return err(
            res,
            'OFFER_RECIPIENT_INVALID',
            by === 'guardian'
              ? 'This player now answers their own Offers.'
              : 'This Offer is answered by your parent or guardian.',
          );
        if (by === 'guardian' && r.recipient.guardianId !== actorId)
          return err(res, 'OFFER_RECIPIENT_INVALID', 'You are no longer the verified guardian route for this player.');
        if (r.recipient.minor && !minorOfferPathwayOpen(org.country ?? 'GB'))
          return err(
            res,
            'OFFER_RECIPIENT_INVALID',
            'No jurisdiction policy for an Offer to a minor is encoded in this build.',
          );
      }
      if (blocked && responseType === 'accepted')
        return err(
          res,
          'OFFER_BLOCKED',
          'You have blocked this organisation. Lift the block before accepting an Offer from it; you may decline it.',
        );
      const gate = canRespondToRevision(o, revisionId, at);
      if (!gate.ok) return err(res, gate.error, gate.message ?? 'This revision cannot be answered.');
      const rev = gate.revision;
      if (!responderMatches(rev, { kind: by, actorId, playerId: o.playerId }))
        return err(res, 'OFFER_RECIPIENT_INVALID', 'This revision was not addressed to you.');
      if (expectedRevOf(req.body) !== null) {
        const rawRev = req.body?.expectedRev ?? req.body?.expectedVersion;
        if (!Number.isInteger(rawRev) || rawRev < 0)
          return err(res, 'OFFER_REV_REQUIRED', 'expectedRev must be a non-negative integer.', {
            field: 'expectedRev',
            expected: 'integer',
          });
        if (
          !guardRev(req, res, o, {
            errorCode: 'OFFER_REV_CONFLICT',
            current: { rev: o.rev, status: effectiveRevisionStatus(rev, at) },
          })
        )
          return;
      }
      const reasonRaw = req.body?.reason;
      if (
        reasonRaw !== undefined &&
        reasonRaw !== null &&
        (typeof reasonRaw !== 'string' || reasonRaw.length > OFFER_LIMITS.declineReason)
      )
        return err(res, 'OFFER_INPUT_INVALID', `A reason is text under ${OFFER_LIMITS.declineReason} characters.`, {
          field: 'reason',
        });
      const reason =
        responseType === 'declined' && typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : null;
      if (reason && !moderateOrRefuse(res, reason, { kind: 'offer_decline', playerId: o.playerId })) return;
      if (limited('offer_response', `${by}:${actorId}`)) return res.status(429).json(rateLimitedBody('offer_response'));

      const who = { kind: by, id: actorId, name: actorName };
      const response = {
        id: nextId('rofa'),
        revisionId: rev.id,
        responseType,
        actorType: by,
        actorId,
        actorName,
        forPlayerId: o.playerId,
        occurredAt: at,
        reason,
        clientKey: key.key,
      };
      // The answer to the live revision discards any unissued draft beside it and makes the answered revision
      // current.
      const draftBeside = currentRevision(o);
      const discard = draftBeside && draftBeside.id !== rev.id && draftBeside.status === 'DRAFT' ? draftBeside : null;
      // The answer is written before the case move so the validator sees it as evidence; one unit.
      const room = caseOfOrg(o.caseId, o.orgId);
      let moved = { applied: false, action: null, reason: 'no_case', at };
      const done = inUnit(res, () => {
        offers.recordResponse(o.id, { response, discardRevisionId: discard?.id ?? null });
        if (room) {
          moved = advanceCase({
            room,
            action: responseType === 'accepted' ? 'recordOfferAccepted' : 'recordOfferDeclined',
            at,
            trigger: `offer:${responseType}:${o.id}`,
            actor: who,
            keyDetail: { offerId: o.id, revisionId: rev.id },
          });
          if (!moved.applied && moved.reason !== 'already_there') {
            // On hold, withdrawn and so on: the Offer is not answered into a state the case cannot record.
            throw new OfferRefusal({
              error: 'OFFER_LIFECYCLE_CONFLICT',
              message:
                'This Offer cannot be answered right now; the club has paused or ended the case. Nothing was recorded.',
              lifecycle: moved.reason,
            });
          }
        }
        const history = discard
          ? [entry('offer_draft_discarded', who, { revisionId: discard.id, byResponseId: response.id }, at)]
          : [];
        history.push(
          entry(
            responseType === 'accepted' ? 'offer_accepted' : 'offer_declined',
            who,
            { revisionId: rev.id, responseId: response.id, hadReason: !!reason },
            at,
          ),
        );
        const fresh = offers.recordAct(o.id, {
          at,
          revBy: null,
          touch: true,
          bump: true,
          bumpRevisionId: rev.id,
          lifecycle: moved,
          history,
        });
        if (room)
          caseAudit(room, by, actorId, actorName, responseType === 'accepted' ? 'offer_accepted' : 'offer_declined', {
            offerId: o.id,
            revisionId: rev.id,
            to: moved.applied ? moved.to : undefined,
          });
        return fresh;
      });
      if (!done) return;
      const answered = done.value;
      // Development-only fault seam after persisting: a retry with the same clientKey replays without a second
      // move or notification.
      if (faults?.shouldFail?.('offer.respond.after_persist'))
        throw new Error('simulated failure after the answer was persisted (development fault layer)');
      if (room)
        safe('offer_responded', () =>
          broadcast?.('offer_responded', {
            orgId: o.orgId,
            roomId: room.id,
            offerId: o.id,
            status: currentRevision(answered)?.status ?? null,
          }),
        );
      safe('notifyClub', () =>
        notifyClub(
          o,
          `${actorName} ${responseType} Offer revision ${rev.revisionNumber} for ${room?.playerName ?? player?.name ?? 'the player'}${responseType === 'accepted' ? ' — accepted in ScoutBox; signing pending' : ''}.`,
        ),
      );
      safe('notifyAgent', () =>
        notifyAgent(
          answered,
          `Your client ${player?.name ?? ''} ${responseType} the Offer from ${org.name ?? 'the club'}.`.replace(
            /\s+/g,
            ' ',
          ),
        ),
      );
      res.json({
        offer: recipientView(answered, at),
        lifecycle: moved,
        signing: {
          created: false,
          note: 'Accepting an Offer in ScoutBox is not a signing. Nothing was signed and no contract exists.',
        },
      });
    };
  }

  /** An adult client shares one Offer with their representing agent. A guardian route cannot share. */
  playerRouter.post('/offers/:id/share-agent', (req, res) => {
    const o = recipientOffer(req, res, { by: 'player', actorId: req.player.id, playerIds: [req.player.id] });
    if (!o) return;
    const at = now(req);
    if (!isAdult(req.player))
      return err(res, 'OFFER_NOT_PERMITTED', "Sharing an Offer with an agent is an adult client's own act.");
    // Un-sharing needs no agent, so a client whose mandate ended can still clear the share.
    if (req.body?.share === false) {
      const history = o.agentShare
        ? [entry('offer_agent_share_withdrawn', { kind: 'player', id: req.player.id, name: req.player.name }, null, at)]
        : [];
      const cleared = unit(() => offers.setAgentShare(o.id, { share: null }, { at, touch: true, history }));
      return res.json({ offer: recipientView(cleared, at) });
    }
    const sole = integration?.soleActiveAgentFor?.(req.player.id, at) ?? { agreement: null, ambiguous: false };
    const agreementId = typeof req.body?.agreementId === 'string' ? req.body.agreementId : null;
    let agreement = sole.agreement;
    if (agreementId) {
      const named = ctx.agentReads.agreements.byId(agreementId);
      agreement =
        named &&
        named.clientId === req.player.id &&
        integration?.basisFor?.({ agentUserId: named.agentUserId, clientId: req.player.id, at })?.ok
          ? named
          : null;
    }
    if (!agreement)
      return err(
        res,
        'OFFER_INPUT_INVALID',
        sole.ambiguous
          ? 'You have more than one active agent. Name the agreement (agreementId) you are sharing with.'
          : 'No active representation agreement to share with.',
        { field: 'agreementId' },
      );
    // A share changes no term, so it does not bump the rev and cannot make the club's next edit conflict.
    const shared = unit(() => {
      const fresh = offers.setAgentShare(
        o.id,
        {
          share: {
            agentUserId: agreement.agentUserId,
            agreementId: agreement.id,
            at,
            by: { kind: 'player', id: req.player.id },
          },
        },
        {
          at,
          touch: true,
          history: [
            entry(
              'offer_agent_shared',
              { kind: 'player', id: req.player.id, name: req.player.name },
              { agreementId: agreement.id },
              at,
            ),
          ],
        },
      );
      notify(
        { kind: 'org_user', id: agreement.agentUserId },
        'recruitment_offer',
        `${req.player.name} shared an Offer with you to read. Their answer is their own act.`,
        o.id,
      );
      return fresh;
    });
    res.json({ offer: recipientView(shared, at) });
  });

  function documentHandler(by) {
    return (req, res) => {
      const actorId = by === 'guardian' ? req.guardian.id : req.player.id;
      const playerIds = by === 'guardian' ? req.guardian.childIds : [req.player.id];
      const o = recipientOffer(req, res, { by, actorId, playerIds });
      if (!o) return;
      // Only a document on an issued (or answered) revision, never a draft's.
      const rev = (o.revisions ?? []).find(
        (r) => wasIssued(r) && (r.documents ?? []).some((d) => d.id === req.params.docId),
      );
      const doc = rev ? rev.documents.find((d) => d.id === req.params.docId) : null;
      if (!doc) return documentNotFound(res, by);
      const ev = ((e) => (e && e.orgId === o.orgId ? e : null))(vaultRecord(doc.evidenceId));
      if (!ev) return documentNotFound(res, by);
      const blob = ev.mediaId && storage?.read ? storage.read(ev.mediaId) : null;
      res.json({
        document: {
          id: doc.id,
          label: doc.label ?? null,
          mime: ev.mime ?? blob?.contentType ?? null,
          bytes: ev.bytes ?? blob?.buffer?.length ?? null,
          filename: ev.filename ?? null,
        },
        file: blob ? { mime: ev.mime ?? blob.contentType, base64: blob.buffer.toString('base64') } : null,
      });
    };
  }

  playerRouter.get('/offers', listHandler('player'));
  playerRouter.get('/offers/:id', readHandler('player'));
  playerRouter.post('/offers/:id/accept', respondHandler('player', 'accepted'));
  playerRouter.post('/offers/:id/decline', respondHandler('player', 'declined'));
  playerRouter.get('/offers/:id/documents/:docId', documentHandler('player'));
  guardianRouter.get('/offers', listHandler('guardian'));
  guardianRouter.get('/offers/:id', readHandler('guardian'));
  guardianRouter.post('/offers/:id/accept', respondHandler('guardian', 'accepted'));
  guardianRouter.post('/offers/:id/decline', respondHandler('guardian', 'declined'));
  guardianRouter.get('/offers/:id/documents/:docId', documentHandler('guardian'));

  // ================================================================== agent

  /**
   * Only Offers the client shared with this agent, and only while the agent's basis, employment/transfer scope
   * and licence hold now. Anyone else sees nothing, including whether an Offer exists.
   */
  orgRouter.get('/agent/clients/:id/offers', (req, res) => {
    if (!access?.resolveMembership?.(req, res)) return;
    const found = access.findOwnAgreement(req, res, req.params.id);
    if (!found) return;
    if (found.summaryOnly)
      return res
        .status(403)
        .json({ error: 'AGENT_ACTION_NOT_PERMITTED', message: "A summary row does not open a client's Offers." });
    const a = found;
    const at = now(req);
    const decision = integration?.decide?.({
      surface: 'client_private',
      clientId: a.clientId,
      agentUserId: req.orgUser.id,
      at,
    }) ?? { allowed: false, code: 'BASIS' };
    if (decision.allowed !== true)
      return res.status(403).json({
        error: decision.code,
        rule: decision.rule ?? null,
        message: "This client's Offers are not open to you right now.",
      });
    const basis = integration?.basisFor?.({ agentUserId: req.orgUser.id, clientId: a.clientId, at });
    const scopeOk = !!basis?.ok && (basis.scope ?? []).some((s) => s === 'employment' || s === 'transfer');
    if (!scopeOk)
      return res.status(403).json({
        error: 'SCOPE_INSUFFICIENT',
        message: 'Your representation scope with this client does not cover employment or transfer.',
      });
    // `client_private` is not a regulated action, so the decision above never checks the licence; an Offer is
    // employment business, so it is checked here, failing closed.
    const licenceCurrent = integration?.licenceCurrentFor
      ? integration.licenceCurrentFor(req.orgUser.id, a.jurisdiction ?? null, at)
      : false;
    if (licenceCurrent !== true)
      return res.status(403).json({
        error: 'LICENCE_NOT_CURRENT',
        rule: 'LICENCE',
        message: "This client's Offers are not open to you right now.",
      });
    const player = findPlayer(a.clientId);
    const items = [];
    for (const o of offers.forPlayer(a.clientId)) {
      if (!soundOffer(o, at)) continue;
      if (!o.agentShare || o.agentShare.agentUserId !== req.orgUser.id) continue;
      if (!liveRevision(o)) continue;
      items.push(withSigning(o, at, offerAgentView(o, at, { orgName: orgOf(o.orgId)?.name ?? null })));
    }
    items.sort((x, y) => (y.sharedAt ?? 0) - (x.sharedAt ?? 0));
    res.json({
      items,
      clientId: a.clientId,
      clientName: player && orgCanSee(req.org, player) ? player.name : null,
      note: "Only the Offers your client chose to share with you, as the club issued them. Accepting or declining is your client's own act; ScoutBox does not let you do it on their behalf.",
      honest: 'Nothing here is a negotiation, a fee or a signing. An accepted Offer is not a signed contract.',
    });
  });

  /** A deleted player leaves ids and states behind, never a name. */
  function onPlayerDeleted(playerId, at) {
    offers.redactPlayer(playerId, at); // inside the deletion unit
  }

  return {
    offerEvidenceReady: true,
    offersOfCase,
    onPlayerDeleted,
  };
}
