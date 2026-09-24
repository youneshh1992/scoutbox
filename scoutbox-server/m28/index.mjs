/**
 * M23 P6 — Canonical Offer Workflow routes.
 *
 *   GET    /org/rooms/:id/offers                     the Offer surface for a case
 *   POST   /org/rooms/:id/offers                     create a DRAFT Offer (explicit club act)
 *   GET    /org/offers/:id                           one Offer, club view
 *   PATCH  /org/offers/:id/draft                     edit the DRAFT revision (own rev)
 *   POST   /org/offers/:id/issue                     ISSUE the exact revision → offer_made
 *   POST   /org/offers/:id/withdraw                  withdraw a DRAFT or an unanswered ISSUED revision
 *   POST   /org/offers/:id/revise                    open a new DRAFT revision on an Offer
 *   GET    /org/offers/:id/history                   append-only history
 *   GET    /org/recruitment/offer-policy             vocabulary
 *
 *   GET    /player/offers  · /player/offers/:id      the recipient's issued Offers
 *   POST   /player/offers/:id/accept · /decline      the recipient's own act → offer_accepted / offer_declined
 *   POST   /player/offers/:id/share-agent            an adult client shares one Offer with their representing agent
 *   GET    /player/offers/:id/documents/:docId       a document on an issued revision
 *   (the same five under /guardian/… for a guardian-controlled recipient)
 *
 *   GET    /org/agent/clients/:id/offers             read-only projection, only of Offers the client shared
 *
 * WHAT NEVER HAPPENS HERE
 *
 * No `case.status = …` (only `ctx.applyLifecycleTransition`, after the ONE
 * validator agreed with the real evidence provider); no `db.signings` read or
 * write; no `signed`, no `under_contract`; no internal decision rationale,
 * assessment, Box Cam observation or transaction note in any payload; no
 * body claim about who the caller is; no client clock.
 */

import { buildShared } from '../m12/shared.mjs';
import { roomRole, roomCan, ROOM_STATUS_LABELS } from '../m17/shared.mjs';
import { guardRev, bumpRev, expectedRevOf } from '../m181/concurrency.mjs';
import { rateLimitedBody } from '../m181/rateLimit.mjs';
import { canTransitionRecruitmentCase, NULL_EVIDENCE_PROVIDER, RECRUITMENT_LIFECYCLE_POLICY_VERSION } from '../m23/lifecycle.mjs';
import { resolveContactRecipient } from '../m23/contact.mjs';
import { visibleToOrg } from '../domain.mjs';
import { sendOfferError, notFound, documentNotFound } from './errors.mjs';
import {
  OFFER_POLICY_VERSION, OFFER_STATUSES, OFFER_STATUS_LABELS, OFFER_TYPES, OFFER_LIMITS, OFFER_RESPONSE_TYPES,
  MINOR_OFFER_PATHWAY_ENABLED, minorOfferPathwayOpen,
  normaliseOfferClientKey, payloadFingerprint, validateTerms, validateMessages, validateExpiry, validateDocumentRefs,
  effectiveRevisionStatus, currentRevision, liveRevision, liveStatus, wasIssued, offerStatus, canRevise, canRespondToRevision, canWithdrawRevision, responderMatches,
  nextRevisionNumber, offerIntegrity, offerClubView, offerRecipientView, offerAgentView, offerHistoryView,
} from './offer.mjs';

const TEST_CLOCK = process.env.SCOUTBOX_TEST_CLOCK === '1';

export function registerOffers(rawCtx) {
  // The established seam (M12 → M23): isLead, orgCanSee and audit come from
  // one place, so an Offer is led, concealed and audited by exactly the rules
  // a Room is.
  const ctx = { ...rawCtx, ...buildShared(rawCtx) };
  const {
    db, orgRouter, playerRouter, guardianRouter, nextId, persistNow, notify, broadcast, findPlayer, isBlocked,
    rateLimit, isLead, moderateOrRefuse, audit, orgCanSee, isAdult, storage,
    agent = null, integration = null, transactions = null,
  } = ctx;

  // The store is created HERE, at registration, on every boot (the M12–M16
  // "module" guarantee in storeContract.mjs). No migration: nothing is
  // backfilled and no lifecycle state is reinterpreted as an Offer (§60–§62).
  db.recruitmentOffers ??= [];

  const err = (res, error, message, extra = {}) => sendOfferError(res, { error, message, ...extra }, 'offer');
  const limited = (action, keyPart) => !!rateLimit?.limited(action, keyPart);
  const roleFor = (req, room) => roomRole({ room, user: req.orgUser, isLead: isLead(req.orgUser) });
  const evidenceProvider = () => ctx.recruitmentEvidenceProvider ?? NULL_EVIDENCE_PROVIDER;
  const orgOf = (orgId) => (db.orgs ?? []).find((o) => o && o.id === orgId) ?? null;
  const now = (req = null) => {
    if (TEST_CLOCK && req?.get) {
      const n = Number(req.get('x-scoutbox-test-clock'));
      if (Number.isFinite(n) && n > 0) return n;
    }
    return Date.now();
  };
  const byOrg = (req) => ({ kind: 'org', id: req.orgUser.id, name: req.orgUser.name, role: req.orgUser.role ?? null });
  const hist = (offer, action, by, detail, at) => {
    offer.history ??= [];
    offer.history.push({ id: nextId('aud'), at, action, by: { kind: by.kind, id: by.id ?? null, name: by.name ?? null }, detail: detail ?? null });
  };

  /** Idempotency keys live on the record, one list per act, never overwritten (§27). */
  const keyList = (offer, act) => { offer.keys ??= {}; if (!Array.isArray(offer.keys[act])) offer.keys[act] = offer.keys[act] ? [offer.keys[act]] : []; return offer.keys[act]; };
  const keyRow = (offer, act, k) => keyList(offer, act).find((x) => x && x.key === k) ?? null;

  function storeOr500(res) {
    if (!Array.isArray(db.recruitmentOffers)) {
      console.error('OFFER store_missing db.recruitmentOffers is absent or not a list');
      err(res, 'OFFER_STORE_MISSING', 'Offers cannot be served right now.');
      return null;
    }
    return db.recruitmentOffers;
  }

  // ------------------------------------------------------------- lookups

  /** Room + role + capability, through M17's concealing lookup. */
  function roomFor(req, res, need) {
    const room = ctx.findRoomForRequest(req, res);
    if (!room) return null;
    const role = roleFor(req, room);
    if (!roomCan(role, need)) {
      err(res, 'OFFER_NOT_PERMITTED', need === 'offer_view' ? 'Your role cannot read Offers on this case.' : 'Only a room lead or recruitment lead can draft, issue or withdraw an Offer.');
      return null;
    }
    return { room, role };
  }

  /** An Offer of THIS organisation, or concealed. Then the room, through the same lookup. */
  function offerFor(req, res, need) {
    if (!storeOr500(res)) return null;
    const o = db.recruitmentOffers.find((x) => x && x.id === req.params.id && x.orgId === req.org.id) ?? null;
    if (!o) { notFound(res, 'club'); return null; }
    const problems = offerIntegrity(o, { orgId: req.org.id });
    if (problems.length) { console.error(`OFFER integrity ${o.id}: ${problems.join(',')}`); err(res, 'OFFER_STATE_UNKNOWN', 'This Offer cannot be read.'); return null; }
    const room = (db.recruitmentCases ?? []).find((k) => k && k.id === o.caseId && k.orgId === req.org.id) ?? null;
    if (!room || !room.room) { notFound(res, 'club'); return null; }
    const role = roleFor(req, room);
    if (!roomCan(role, need)) {
      err(res, 'OFFER_NOT_PERMITTED', need === 'offer_view' ? 'Your role cannot read Offers on this case.' : 'Only a room lead or recruitment lead can draft, issue or withdraw an Offer.');
      return null;
    }
    return { offer: o, room, role };
  }

  const offersOfCase = (kase) => (db.recruitmentOffers ?? []).filter((o) => o && o.caseId === kase.id && o.orgId === kase.orgId);
  const liveOfferOf = (kase, at) => offersOfCase(kase).find((o) => ['DRAFT', 'ISSUED'].includes(offerStatus(o, at))) ?? null;
  const subjectRemoved = (kase) => !!kase.subjectRemovedAt || !findPlayer(kase.playerId);

  /** The recipient rule (P3), re-derived now — never trusted from the record. */
  function recipientFor(org, playerId, at) {
    const r = resolveContactRecipient({ player: findPlayer(playerId), org, guardians: db.guardians ?? [], isAdult, visibleToOrg, isBlocked, now: new Date(at) });
    if (r.ok) return r;
    const error = r.error === 'CONTACT_BLOCKED' ? 'OFFER_BLOCKED' : 'OFFER_RECIPIENT_INVALID';
    return { ok: false, error, message: error === 'OFFER_BLOCKED' ? 'This player (or their guardian) has blocked your organisation.' : (r.error === 'CONTACT_GUARDIAN_REQUIRED' ? 'This player is under the age of majority and no valid guardian route exists.' : r.message) };
  }

  /**
   * `expectedRev` is REQUIRED on every club mutation of an existing Offer and
   * is an integer — never coerced (§28). ONE rev, the Offer's: every change
   * to any revision, and every recipient answer, moves it; a client edits the
   * Offer it was looking at, whichever revision that touches.
   */
  function revGate(req, res, record) {
    const exp = expectedRevOf(req.body);
    if (exp === null) { err(res, 'OFFER_REV_REQUIRED', 'expectedRev is required: send the rev you were looking at.'); return false; }
    const rawRev = req.body?.expectedRev ?? req.body?.expectedVersion;
    if (!Number.isInteger(rawRev) || rawRev < 0) { err(res, 'OFFER_REV_REQUIRED', 'expectedRev must be a non-negative integer.', { field: 'expectedRev', expected: 'integer' }); return false; }
    return guardRev(req, res, record, { errorCode: 'OFFER_REV_CONFLICT', current: { rev: Number.isInteger(record.rev) ? record.rev : 1, status: record.status } });
  }

  /** A document reference names a vault record THIS organisation owns (the P5.6D rule). */
  function resolveDocuments(refs, orgId) {
    const out = [];
    for (const d of refs) {
      const ev = (db.verEvidence ?? []).find((e) => e && e.id === d.evidenceId);
      if (!ev || ev.orgId !== orgId) return { ok: false, error: 'OFFER_DOCUMENT_INVALID', field: 'documents', message: 'No evidence record of yours matches that reference.' };
      out.push({ id: nextId('rofd'), evidenceId: ev.id, label: d.label ?? ev.filename ?? null, mime: ev.mime ?? null, bytes: ev.bytes ?? null });
    }
    return { ok: true, documents: out };
  }

  /** What blocks a draft or an issue right now — codes for the screen, checked again on the mutation. */
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
      else if (rec.recipient.minor && !minorOfferPathwayOpen(orgOf(kase.orgId)?.country ?? 'GB')) blockers.push('MINOR_PATHWAY_CLOSED');
      if (offer?.transactionId) {
        const r = transactions?.offerReadinessFor?.(offer.transactionId, { orgId: kase.orgId, caseId: kase.id }) ?? null;
        if (!r) blockers.push('TRANSACTION_MISSING');
        else if (!r.readiness.canStartOfferWorkflow) blockers.push('TRANSACTION_NOT_READY');
      }
    }
    return [...new Set(blockers)];
  }

  // ------------------------------------------------------- lifecycle coupling

  /**
   * The Trial pattern: ask the ONE validator, with the real evidence provider,
   * then write through the ONE writer. A recipient-driven move names the
   * recipient as actor. Returns the effect; never throws, never assigns status.
   */
  function advanceCase({ req = null, room, action, at, trigger, actor = null, keyDetail = {} }) {
    const role = req && !actor ? roleFor(req, room) : 'recruitment_admin';
    const verdict = canTransitionRecruitmentCase(room, action, { role, evidence: evidenceProvider(), now: at });
    if (verdict.ok) {
      const org = orgOf(room.orgId);
      const { from, to } = ctx.applyLifecycleTransition({ req, room, to: verdict.to, reasonCodes: [], trigger, actor: actor ? { ...actor, org } : null });
      const last = room.history[room.history.length - 1];
      if (last?.action === 'room_status_changed') last.detail = { ...last.detail, lifecycleAction: action, clientKey: null, policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION, ...keyDetail };
      return { applied: true, action, from, to, at };
    }
    if (verdict.error === 'LIFECYCLE_NO_CHANGE') return { applied: false, action, reason: 'already_there', from: room.room.status, to: room.room.status, at };
    return { applied: false, action, reason: verdict.error, message: verdict.message ?? null, allowed: verdict.allowed ?? [], from: room.room.status, to: null, at };
  }

  // ------------------------------------------------------------ notifications

  function notifyClub(offer, text) {
    const room = (db.recruitmentCases ?? []).find((k) => k?.id === offer.caseId);
    const ids = new Set([room?.ownerUserId, room?.room?.leadScoutUserId, currentRevision(offer)?.issuedBy?.id].filter(Boolean));
    for (const uid of ids) notify({ kind: 'org_user', id: uid }, 'recruitment_offer', text, offer.id);
  }
  function notifyRecipient(rev, text, offerId) {
    const snap = rev?.recipientSnapshot;
    if (!snap) return;
    if (snap.type === 'guardian' && snap.guardianId) notify({ kind: 'guardian', id: snap.guardianId }, 'recruitment_offer', text, offerId);
    else notify({ kind: 'player', id: snap.playerId }, 'recruitment_offer', text, offerId);
  }
  /** The shared agent hears a factual line only when the client shared the Offer and still may (§37). */
  function notifyAgent(offer, text) {
    const s = offer.agentShare;
    if (!s?.agentUserId) return;
    const basis = integration?.basisFor?.({ agentUserId: s.agentUserId, clientId: offer.playerId, at: now() });
    if (basis?.ok) notify({ kind: 'org_user', id: s.agentUserId }, 'recruitment_offer', text, offer.id);
  }

  // ================================================================== CLUB

  orgRouter.get('/rooms/:id/offers', (req, res) => {
    const got = roomFor(req, res, 'offer_view');
    if (!got) return;
    if (!storeOr500(res)) return;
    const { room: kase, role } = got;
    const at = now(req);
    const offers = offersOfCase(kase).map((o) => offerClubView(o, at)).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const live = liveOfferOf(kase, at);
    res.json({
      offers,
      liveOfferId: live?.id ?? null,
      requirements: {
        role, canDraft: roomCan(role, 'offer_draft'), canIssue: roomCan(role, 'offer_issue'),
        status: kase.room?.status ?? null, statusLabel: ROOM_STATUS_LABELS[kase.room?.status] ?? null,
        draftBlockers: blockersFor(kase, role, at),
        issueBlockers: live && offerStatus(live, at) === 'DRAFT' ? blockersFor(kase, role, at, { forIssue: true, offer: live }) : [],
        blocked: isBlocked(kase.playerId, kase.orgId), subjectRemoved: subjectRemoved(kase),
      },
      vocabulary: { statuses: OFFER_STATUSES, statusLabels: { ...OFFER_STATUS_LABELS }, types: OFFER_TYPES, responseTypes: OFFER_RESPONSE_TYPES },
      limits: { ...OFFER_LIMITS },
      policyVersion: OFFER_POLICY_VERSION,
      note: 'An Offer is created only by an explicit act here. A positive recruitment decision opens the door; it never walks through it. Issuing an Offer moves the case to Offer made; the recipient\'s own acceptance or decline moves it on. Nothing here is a signing.',
    });
  });

  orgRouter.post('/rooms/:id/offers', (req, res) => {
    const got = roomFor(req, res, 'offer_draft');
    if (!got) return;
    if (!storeOr500(res)) return;
    const { room: kase, role } = got;
    const at = now(req);
    const key = normaliseOfferClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const terms = validateTerms(req.body?.terms);
    if (!terms.ok) return err(res, terms.error, terms.message, { field: terms.field, ...(terms.allowed ? { allowed: terms.allowed } : {}), ...(terms.expected ? { expected: terms.expected } : {}) });
    const msgs = validateMessages(req.body ?? {});
    if (!msgs.ok) return err(res, msgs.error, msgs.message, { field: msgs.field });
    const expiry = validateExpiry(req.body?.expiresAt, { now: at });
    if (!expiry.ok) return err(res, expiry.error, expiry.message, { field: 'expiresAt', ...(expiry.expected ? { expected: expiry.expected } : {}) });
    const docRefs = validateDocumentRefs(req.body?.documents);
    if (!docRefs.ok) return err(res, docRefs.error, docRefs.message, { field: 'documents' });
    const fp = payloadFingerprint({ terms: terms.terms, recipientMessage: msgs.recipientMessage, internalNote: msgs.internalNote, expiresAt: expiry.ms, documents: (docRefs.documents ?? []).map((d) => d.evidenceId) });
    if (key.key) {
      const prior = offersOfCase(kase).find((o) => o.keys?.create?.key === key.key);
      if (prior) {
        if (prior.keys.create.fp === fp) return res.json({ offer: offerClubView(prior, at), idempotent: true });
        return err(res, 'OFFER_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different Offer.');
      }
    }
    // The create gate (§9), in order: subject, block, case state, decision, one live Offer per case.
    if (subjectRemoved(kase)) return err(res, 'OFFER_SUBJECT_REMOVED', 'This player removed their ScoutBox account. No Offer is written about a person who left.');
    if (isBlocked(kase.playerId, kase.orgId)) return err(res, 'OFFER_BLOCKED', 'This player (or their guardian) has blocked your organisation. No Offer is drafted while the block stands.');
    if (kase.room?.status !== 'offer_consideration') return err(res, 'OFFER_STATE_INVALID', `An Offer is drafted from Offer consideration; this case is at "${ROOM_STATUS_LABELS[kase.room?.status] ?? kase.room?.status}".`, { current: { status: kase.room?.status ?? null } });
    const dp = evidenceProvider().check('decision_progress', { kase, now: at });
    if (dp?.satisfied !== true) return err(res, 'OFFER_ISSUE_NOT_ALLOWED', 'A finalized recruitment decision to progress must stand on this case before an Offer is drafted.', { reasons: ['DECISION_REQUIRED'] });
    const live = liveOfferOf(kase, at);
    if (live) return err(res, 'OFFER_STATE_INVALID', 'This case already has a live Offer. Edit, issue or withdraw it; a changed Offer is a new revision, not a second Offer.', { current: { offerId: live.id, status: offerStatus(live, at) } });
    if (limited('offer_draft_write', req.org.id)) return res.status(429).json(rateLimitedBody('offer_draft_write'));
    let transactionId = null;
    if (!(req.body?.transactionId === undefined || req.body?.transactionId === null || req.body?.transactionId === '')) {
      if (typeof req.body.transactionId !== 'string') return err(res, 'OFFER_INPUT_INVALID', 'transactionId must be text.', { field: 'transactionId' });
      const r = transactions?.offerReadinessFor?.(req.body.transactionId, { orgId: kase.orgId, caseId: kase.id }) ?? null;
      if (!r) return err(res, 'OFFER_INPUT_INVALID', 'No transaction workspace of yours for this case matches that reference.', { field: 'transactionId' });
      transactionId = r.tx.id;
    }
    const docs = resolveDocuments(docRefs.documents ?? [], kase.orgId);
    if (!docs.ok) return err(res, docs.error, docs.message, { field: docs.field });
    if (msgs.recipientMessage && !moderateOrRefuse(res, msgs.recipientMessage, { kind: 'recruitment_offer', orgId: req.org.id, userId: req.orgUser.id })) return;
    const by = byOrg(req);
    const rev = {
      id: nextId('rofr'), revisionNumber: 1, status: 'DRAFT',
      terms: terms.terms, recipientMessage: msgs.recipientMessage, internalNote: msgs.internalNote, documents: docs.documents,
      expiresAt: expiry.ms, createdAt: at, createdBy: by, updatedAt: at, updatedBy: by,
      issuedAt: null, issuedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: null,
      respondedAt: null, response: null, supersedesRevisionId: null, supersededByRevisionId: null, supersededAt: null,
      recipientSnapshot: null, readinessSnapshot: null, rev: 1, revAt: at, revBy: null,
    };
    const offer = {
      id: nextId('rof'), orgId: kase.orgId, caseId: kase.id, playerId: kase.playerId, type: terms.terms.offerType,
      decisionId: dp.sourceId ?? null, transactionId, status: 'DRAFT', currentRevisionId: rev.id,
      revisions: [rev], responses: [], readReceipts: [], agentShare: null,
      keys: { create: key.key ? { key: key.key, fp } : null, issue: [], withdraw: [], revise: [] },
      lifecycle: null, history: [], createdAt: at, createdBy: by, updatedAt: at, rev: 1, revAt: at, revBy: null, policyVersion: OFFER_POLICY_VERSION,
    };
    hist(offer, 'offer_draft_created', by, { revisionId: rev.id, revisionNumber: 1 }, at);
    db.recruitmentOffers.push(offer);
    audit(kase, 'org', req.orgUser.id, req.orgUser.name, 'offer_draft_created', { offerId: offer.id, revisionId: rev.id });
    persistNow();
    broadcast?.('offer_draft_created', { orgId: kase.orgId, roomId: kase.id, offerId: offer.id });
    res.status(201).json({ offer: offerClubView(offer, at) });
  });

  orgRouter.get('/offers/:id', (req, res) => {
    const got = offerFor(req, res, 'offer_view');
    if (!got) return;
    res.json({ offer: offerClubView(got.offer, now(req)) });
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
    if (effectiveRevisionStatus(rev, at) !== 'DRAFT') return err(res, 'OFFER_STATE_INVALID', 'Only a draft revision can be edited. Issued terms are immutable; open a new revision to change them.', { current: { status: effectiveRevisionStatus(rev, at) } });
    if (subjectRemoved(kase)) return err(res, 'OFFER_SUBJECT_REMOVED', 'This player removed their ScoutBox account. The draft can no longer be changed.');
    const b = req.body ?? {};
    const terms = b.terms !== undefined ? validateTerms(b.terms) : null;
    if (terms && !terms.ok) return err(res, terms.error, terms.message, { field: terms.field, ...(terms.allowed ? { allowed: terms.allowed } : {}), ...(terms.expected ? { expected: terms.expected } : {}) });
    const msgs = validateMessages({ recipientMessage: b.recipientMessage !== undefined ? b.recipientMessage : rev.recipientMessage, internalNote: b.internalNote !== undefined ? b.internalNote : rev.internalNote });
    if (!msgs.ok) return err(res, msgs.error, msgs.message, { field: msgs.field });
    const expiry = b.expiresAt !== undefined ? validateExpiry(b.expiresAt, { now: at }) : null;
    if (expiry && !expiry.ok) return err(res, expiry.error, expiry.message, { field: 'expiresAt', ...(expiry.expected ? { expected: expiry.expected } : {}) });
    const docRefs = validateDocumentRefs(b.documents);
    if (!docRefs.ok) return err(res, docRefs.error, docRefs.message, { field: 'documents' });
    if (!revGate(req, res, offer)) return;
    if (limited('offer_draft_write', req.org.id)) return res.status(429).json(rateLimitedBody('offer_draft_write'));
    let docs = null;
    if (docRefs.documents !== undefined) { docs = resolveDocuments(docRefs.documents, kase.orgId); if (!docs.ok) return err(res, docs.error, docs.message, { field: docs.field }); }
    if (b.recipientMessage !== undefined && msgs.recipientMessage && !moderateOrRefuse(res, msgs.recipientMessage, { kind: 'recruitment_offer', orgId: req.org.id, userId: req.orgUser.id })) return;
    const by = byOrg(req);
    if (terms) rev.terms = terms.terms;
    rev.recipientMessage = msgs.recipientMessage;
    rev.internalNote = msgs.internalNote;
    if (expiry) rev.expiresAt = expiry.ms;
    if (docs) rev.documents = docs.documents;
    rev.updatedAt = at; rev.updatedBy = by;
    bumpRev(rev, { by: req.orgUser, at });
    offer.type = rev.terms.offerType;
    offer.updatedAt = at;
    bumpRev(offer, { by: req.orgUser, at });
    hist(offer, 'offer_draft_updated', by, { revisionId: rev.id }, at);
    persistNow();
    broadcast?.('offer_draft_updated', { orgId: kase.orgId, roomId: kase.id, offerId: offer.id });
    res.json({ offer: offerClubView(offer, at) });
  });

  /**
   * ISSUE — the most important mutation (§17). Everything is re-resolved
   * now: role (offerFor), org/case ownership (offerFor), state, expectedRev,
   * subject, block, recipient (adult / guardian route / minor pathway),
   * transaction readiness, expiry validity, document ownership, and then the
   * lifecycle through the ONE validator. Built in memory; persisted once with
   * the case move, or not at all.
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
      if (usedIssue.revisionId === rev.id) return res.json({ offer: offerClubView(offer, at), lifecycle: offer.lifecycle ?? null, idempotent: true });
      return err(res, 'OFFER_IDEMPOTENCY_CONFLICT', 'This clientKey was already used to issue a different revision.');
    }
    const st = effectiveRevisionStatus(rev, at);
    if (st !== 'DRAFT') return err(res, 'OFFER_STATE_INVALID', st === 'ISSUED' ? 'This revision is already issued.' : 'Only a draft revision can be issued.', { current: { status: st } });
    const liveNow = liveStatus(offer, at);
    if (liveNow === 'ACCEPTED') return err(res, 'OFFER_STATE_INVALID', 'The recipient accepted the revision that is out. A new revision is not issued over an acceptance.', { current: { status: liveNow } });
    if (!revGate(req, res, offer)) return;
    if (subjectRemoved(kase)) return err(res, 'OFFER_SUBJECT_REMOVED', 'This player removed their ScoutBox account. No Offer is issued to a person who left.');
    if (isBlocked(kase.playerId, kase.orgId)) return err(res, 'OFFER_BLOCKED', 'This player (or their guardian) has blocked your organisation. An Offer is not issued while the block stands.');
    if (!['offer_consideration', 'offer_made'].includes(kase.room?.status)) return err(res, 'OFFER_LIFECYCLE_CONFLICT', `The case at "${ROOM_STATUS_LABELS[kase.room?.status] ?? kase.room?.status}" cannot take an issued Offer.`, { current: { status: kase.room?.status ?? null } });
    // The exact revision, re-validated as an ISSUED one: complete terms, a real expiry in range.
    const terms = validateTerms(rev.terms, { requireComplete: true });
    if (!terms.ok) return err(res, terms.error, terms.message, { field: terms.field });
    const expiry = validateExpiry(rev.expiresAt, { now: at, required: true });
    if (!expiry.ok) return err(res, expiry.error, expiry.message, { field: 'expiresAt' });
    // Documents named at draft time must still be this organisation's.
    for (const d of rev.documents ?? []) {
      const ev = (db.verEvidence ?? []).find((e) => e && e.id === d.evidenceId);
      if (!ev || ev.orgId !== kase.orgId) return err(res, 'OFFER_DOCUMENT_INVALID', 'A document on this draft no longer belongs to your organisation.', { field: 'documents' });
    }
    // The recipient, resolved NOW (§13): an adult player, or a guardian route — and the minor pathway is closed in this build.
    const org = orgOf(kase.orgId) ?? { id: kase.orgId };
    const rec = recipientFor(org, kase.playerId, at);
    if (!rec.ok) return err(res, rec.error, rec.message);
    if (rec.recipient.minor && !minorOfferPathwayOpen(org.country ?? 'GB')) {
      return err(res, 'OFFER_RECIPIENT_INVALID', 'This player is under the age of majority. No jurisdiction policy for an Offer to a minor is encoded in this build, so the Offer is not issued.', { reasons: ['MINOR_PATHWAY_CLOSED'] });
    }
    // Transaction readiness, re-evaluated now, never from the draft's snapshot (§11).
    let readiness = null;
    if (offer.transactionId) {
      const r = transactions?.offerReadinessFor?.(offer.transactionId, { orgId: kase.orgId, caseId: kase.id }) ?? null;
      if (!r) return err(res, 'OFFER_COMPLIANCE_BLOCKED', 'The transaction workspace this Offer references is no longer available to you.', { blockers: ['TRANSACTION_MISSING'] });
      if (!r.readiness.canStartOfferWorkflow) return err(res, 'OFFER_COMPLIANCE_BLOCKED', 'The transaction workspace does not currently permit an Offer.', { blockers: r.readiness.blockers });
      readiness = { transactionId: r.tx.id, evaluatedAt: at, status: r.tx.status, blockers: [] };
    }
    if (limited('offer_issue', req.org.id)) return res.status(429).json(rateLimitedBody('offer_issue'));

    // ---- Freeze the revision in memory; supersede the previous issued one; then the case.
    const by = byOrg(req);
    const prevIssued = (offer.revisions ?? []).find((r) => r.id === rev.supersedesRevisionId && r.status === 'ISSUED') ?? null;
    const before = { status: rev.status, prevStatus: prevIssued?.status ?? null, offerStatus: offer.status, lifecycle: offer.lifecycle };
    rev.status = 'ISSUED';
    rev.terms = terms.terms;
    rev.issuedAt = at; rev.issuedBy = by;
    rev.recipientSnapshot = { type: rec.recipient.type, playerId: rec.recipient.playerId, guardianId: rec.recipient.guardianId ?? null, minor: rec.recipient.minor === true, at };
    rev.readinessSnapshot = readiness;
    if (prevIssued) { prevIssued.status = 'SUPERSEDED'; prevIssued.supersededByRevisionId = rev.id; prevIssued.supersededAt = at; }
    offer.status = 'ISSUED';
    const rollback = () => { rev.status = before.status; rev.issuedAt = null; rev.issuedBy = null; rev.recipientSnapshot = null; rev.readinessSnapshot = null; if (prevIssued) { prevIssued.status = before.prevStatus; prevIssued.supersededByRevisionId = null; prevIssued.supersededAt = null; } offer.status = before.offerStatus; };
    const moved = advanceCase({ req, room: kase, action: 'sendOffer', at, trigger: `offer:issue:${offer.id}`, keyDetail: { offerId: offer.id, revisionId: rev.id } });
    if (!moved.applied && moved.reason !== 'already_there') {
      rollback();
      return err(res, 'OFFER_LIFECYCLE_CONFLICT', `The case at "${ROOM_STATUS_LABELS[moved.from] ?? moved.from}" cannot take the step an issued Offer asks for (sendOffer). ${moved.message ?? ''}`.trim(), { lifecycle: moved.reason, allowed: moved.allowed ?? [], current: { status: moved.from } });
    }
    offer.lifecycle = moved;
    if (key.key) keyList(offer, 'issue').push({ key: key.key, revisionId: rev.id });
    offer.updatedAt = at;
    bumpRev(rev, { by: req.orgUser, at });
    bumpRev(offer, { by: req.orgUser, at });
    hist(offer, prevIssued ? 'offer_superseded' : 'offer_issued', by, { revisionId: rev.id, revisionNumber: rev.revisionNumber, supersedes: prevIssued?.id ?? null, expiresAt: rev.expiresAt }, at);
    if (prevIssued) hist(offer, 'offer_issued', by, { revisionId: rev.id, revisionNumber: rev.revisionNumber, expiresAt: rev.expiresAt }, at);
    audit(kase, 'org', req.orgUser.id, req.orgUser.name, prevIssued ? 'offer_superseded' : 'offer_issued', { offerId: offer.id, revisionId: rev.id, supersedes: prevIssued?.id ?? null, to: moved.applied ? moved.to : undefined });
    persistNow();
    if (prevIssued) broadcast?.('offer_superseded', { orgId: kase.orgId, roomId: kase.id, offerId: offer.id });
    broadcast?.('offer_issued', { orgId: kase.orgId, roomId: kase.id, offerId: offer.id });
    notifyRecipient(rev, `${org.name ?? 'A club'} has issued you an Offer${prevIssued ? ' (a revised one)' : ''}. Read the exact terms in ScoutBox and answer before it expires. Accepting is not a signing.`, offer.id);
    notifyAgent(offer, `Your client ${kase.playerName ?? ''} received a${prevIssued ? ' revised' : 'n'} Offer from ${org.name ?? 'a club'}. Their answer is their own act.`.replace(/\s+/g, ' '));
    for (const uid of new Set([kase.ownerUserId, kase.room?.leadScoutUserId])) {
      if (!uid || uid === req.orgUser.id) continue;
      notify({ kind: 'org_user', id: uid }, 'recruitment_offer', `Recruitment Room — ${kase.playerName ?? 'a removed player'}: Offer revision ${rev.revisionNumber} issued.`, offer.id);
    }
    res.json({ offer: offerClubView(offer, at), lifecycle: moved, case: moved.applied ? { from: moved.from, to: moved.to } : { unchanged: true, status: kase.room.status }, rev: kase.room.rev });
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
      if (usedWithdraw.revisionId === rev.id) return res.json({ offer: offerClubView(offer, at), lifecycle: offer.lifecycle ?? null, idempotent: true });
      return err(res, 'OFFER_IDEMPOTENCY_CONFLICT', 'This clientKey was already used to withdraw a different revision.');
    }
    const w = canWithdrawRevision(offer, at);
    if (!w.ok) return err(res, w.error, w.message, w.current ? { current: w.current } : {});
    const reasonRaw = req.body?.reason;
    if (reasonRaw !== undefined && reasonRaw !== null && (typeof reasonRaw !== 'string' || reasonRaw.length > OFFER_LIMITS.withdrawReason)) return err(res, 'OFFER_INPUT_INVALID', `A reason is text under ${OFFER_LIMITS.withdrawReason} characters.`, { field: 'reason' });
    const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : null;
    if (!revGate(req, res, offer)) return;
    // A block does not stop a withdrawal: it is a closure, and the recipient is not approached (§29).
    if (limited('offer_withdraw', req.org.id)) return res.status(429).json(rateLimitedBody('offer_withdraw'));
    const by = byOrg(req);
    const wasIssued = w.from === 'ISSUED';
    rev.status = 'WITHDRAWN'; rev.withdrawnAt = at; rev.withdrawnBy = by; rev.withdrawReason = reason;
    offer.status = 'WITHDRAWN';
    // An issued Offer withdrawn from Offer made steps the case back to Offer consideration:
    // the decision still stands, and the club may reissue (§18). A withdrawn draft moves nothing.
    let moved = { applied: false, action: null, reason: 'draft', from: kase.room.status, to: kase.room.status, at };
    if (wasIssued && kase.room?.status === 'offer_made') moved = advanceCase({ req, room: kase, action: 'considerOffer', at, trigger: `offer:withdraw:${offer.id}`, keyDetail: { offerId: offer.id, revisionId: rev.id } });
    offer.lifecycle = moved;
    if (key.key) keyList(offer, 'withdraw').push({ key: key.key, revisionId: rev.id });
    offer.updatedAt = at;
    bumpRev(rev, { by: req.orgUser, at });
    bumpRev(offer, { by: req.orgUser, at });
    hist(offer, 'offer_withdrawn', by, { revisionId: rev.id, wasIssued, hadReason: !!reason }, at);
    audit(kase, 'org', req.orgUser.id, req.orgUser.name, 'offer_withdrawn', { offerId: offer.id, revisionId: rev.id, wasIssued, to: moved.applied ? moved.to : undefined });
    persistNow();
    broadcast?.('offer_withdrawn', { orgId: kase.orgId, roomId: kase.id, offerId: offer.id });
    if (wasIssued) {
      notifyRecipient(rev, `${orgOf(kase.orgId)?.name ?? 'The club'} has withdrawn its Offer. Nothing further is needed from you.`, offer.id);
      notifyAgent(offer, `The Offer to your client ${kase.playerName ?? ''} was withdrawn by the club.`.replace(/\s+/g, ' '));
    }
    res.json({ offer: offerClubView(offer, at), lifecycle: moved });
  });

  /** A new DRAFT revision on an Offer whose current revision is issued, expired, withdrawn or declined (§25). */
  orgRouter.post('/offers/:id/revise', (req, res) => {
    const got = offerFor(req, res, 'offer_draft');
    if (!got) return;
    const { offer, room: kase } = got;
    const at = now(req);
    const key = normaliseOfferClientKey(req.body?.clientKey);
    if (!key.ok) return err(res, key.error, key.message);
    const usedRevise = key.key ? keyRow(offer, 'revise', key.key) : null;
    if (usedRevise && (offer.revisions ?? []).some((r) => r.id === usedRevise.revisionId)) return res.json({ offer: offerClubView(offer, at), idempotent: true });
    const c = canRevise(offer, at);
    if (!c.ok) return err(res, c.error, c.message ?? 'This Offer cannot be revised.');
    if (subjectRemoved(kase)) return err(res, 'OFFER_SUBJECT_REMOVED', 'This player removed their ScoutBox account. No new revision is written.');
    if (isBlocked(kase.playerId, kase.orgId)) return err(res, 'OFFER_BLOCKED', 'This player (or their guardian) has blocked your organisation. No new revision is drafted while the block stands.');
    if (!['offer_consideration', 'offer_made'].includes(kase.room?.status)) return err(res, 'OFFER_LIFECYCLE_CONFLICT', `The case at "${ROOM_STATUS_LABELS[kase.room?.status] ?? kase.room?.status}" cannot take a new Offer revision.`, { current: { status: kase.room?.status ?? null } });
    const prev = currentRevision(offer);
    if (!revGate(req, res, offer)) return;
    const b = req.body ?? {};
    const terms = validateTerms(b.terms !== undefined ? b.terms : prev.terms);
    if (!terms.ok) return err(res, terms.error, terms.message, { field: terms.field });
    const msgs = validateMessages({ recipientMessage: b.recipientMessage !== undefined ? b.recipientMessage : prev.recipientMessage, internalNote: b.internalNote !== undefined ? b.internalNote : prev.internalNote });
    if (!msgs.ok) return err(res, msgs.error, msgs.message, { field: msgs.field });
    const expiry = validateExpiry(b.expiresAt !== undefined ? b.expiresAt : null, { now: at });
    if (!expiry.ok) return err(res, expiry.error, expiry.message, { field: 'expiresAt' });
    const docRefs = validateDocumentRefs(b.documents);
    if (!docRefs.ok) return err(res, docRefs.error, docRefs.message, { field: 'documents' });
    if (limited('offer_draft_write', req.org.id)) return res.status(429).json(rateLimitedBody('offer_draft_write'));
    let docs = { ok: true, documents: (prev.documents ?? []).map((d) => ({ ...d, id: nextId('rofd') })) };
    if (docRefs.documents !== undefined) { docs = resolveDocuments(docRefs.documents, kase.orgId); if (!docs.ok) return err(res, docs.error, docs.message, { field: docs.field }); }
    if (b.recipientMessage !== undefined && msgs.recipientMessage && !moderateOrRefuse(res, msgs.recipientMessage, { kind: 'recruitment_offer', orgId: req.org.id, userId: req.orgUser.id })) return;
    const by = byOrg(req);
    const rev = {
      id: nextId('rofr'), revisionNumber: nextRevisionNumber(offer), status: 'DRAFT',
      terms: terms.terms, recipientMessage: msgs.recipientMessage, internalNote: msgs.internalNote, documents: docs.documents,
      expiresAt: expiry.ms, createdAt: at, createdBy: by, updatedAt: at, updatedBy: by,
      issuedAt: null, issuedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: null,
      respondedAt: null, response: null, supersedesRevisionId: c.from === 'ISSUED' ? prev.id : null, supersededByRevisionId: null, supersededAt: null,
      recipientSnapshot: null, readinessSnapshot: null, rev: 1, revAt: at, revBy: null,
    };
    offer.revisions.push(rev);
    offer.currentRevisionId = rev.id;
    offer.status = 'DRAFT';
    if (key.key) keyList(offer, 'revise').push({ key: key.key, revisionId: rev.id });
    offer.updatedAt = at;
    bumpRev(offer, { by: req.orgUser, at });
    hist(offer, 'offer_draft_created', by, { revisionId: rev.id, revisionNumber: rev.revisionNumber, supersedes: rev.supersedesRevisionId }, at);
    audit(kase, 'org', req.orgUser.id, req.orgUser.name, 'offer_draft_created', { offerId: offer.id, revisionId: rev.id, revises: prev.id });
    persistNow();
    broadcast?.('offer_draft_created', { orgId: kase.orgId, roomId: kase.id, offerId: offer.id });
    res.status(201).json({ offer: offerClubView(offer, at) });
  });

  orgRouter.get('/recruitment/offer-policy', (_req, res) => {
    res.json({
      policyVersion: OFFER_POLICY_VERSION, statuses: OFFER_STATUSES, statusLabels: { ...OFFER_STATUS_LABELS }, types: OFFER_TYPES,
      responseTypes: OFFER_RESPONSE_TYPES, limits: { ...OFFER_LIMITS }, minorPathway: { ...MINOR_OFFER_PATHWAY_ENABLED },
      lifecycle: { issue: 'offer_made', accept: 'offer_accepted', decline: 'offer_declined', withdraw: 'offer_consideration' },
      note: 'A recruitment decision authorises considering an Offer and creates none. Only an issued revision reaches Offer made; only the recipient\'s own act reaches accepted or declined; an acceptance is not a signing and P6 writes no signing.',
    });
  });

  // ================================================================== RECIPIENT

  /**
   * The recipient's Offers: issued revisions addressed to the caller (or, for a
   * guardian, to a child they currently control), re-authorised against the
   * live recipient rule on every read — a route that a lost guardianship or a
   * new block changes at once.
   */
  function recipientOffers({ by, actorId, playerIds, at }) {
    const out = [];
    for (const o of db.recruitmentOffers ?? []) {
      if (!o || !playerIds.includes(o.playerId)) continue;
      if (offerIntegrity(o).length) continue;
      const live = liveRevision(o);
      if (!live) continue; // a draft — or a draft withdrawn before issue — is invisible, not redacted
      const snap = live.recipientSnapshot;
      if (!snap || snap.type !== by) continue;
      if (by === 'guardian' && snap.guardianId !== actorId) continue;
      out.push(o);
    }
    return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  function recipientOffer(req, res, { by, actorId, playerIds }) {
    if (!storeOr500(res)) return null;
    const at = now(req);
    const o = recipientOffers({ by, actorId, playerIds, at }).find((x) => x.id === req.params.id) ?? null;
    if (!o) { notFound(res, by); return null; }
    return o;
  }

  const recipientView = (o, at) => offerRecipientView(o, at, { orgName: orgOf(o.orgId)?.name ?? null });

  /** A read receipt for the live revision (§40): a fact about delivery, never a status. Returns true when a new one was recorded. */
  function markViewed(o, { kind, id }, at, { persist = true } = {}) {
    const cur = liveRevision(o);
    if (!cur) return false;
    o.readReceipts ??= [];
    if (o.readReceipts.some((r) => r && r.revisionId === cur.id && r.viewerKind === kind && r.viewerId === id)) return false;
    o.readReceipts.push({ revisionId: cur.id, viewerKind: kind, viewerId: id, firstViewedAt: at });
    hist(o, 'offer_viewed', { kind, id, name: null }, { revisionId: cur.id }, at);
    if (persist) persistNow();
    return true;
  }

  function listHandler(by) {
    return (req, res) => {
      if (!storeOr500(res)) return;
      const at = now(req);
      const actorId = by === 'guardian' ? req.guardian.id : req.player.id;
      const playerIds = by === 'guardian' ? req.guardian.childIds : [req.player.id];
      // The list shows the full terms, so listing IS the recipient's first sight of a revision: one receipt per live revision, persisted once.
      const rows = recipientOffers({ by, actorId, playerIds, at });
      let added = false;
      for (const o of rows) if (markViewed(o, { kind: by, id: actorId }, at, { persist: false })) added = true;
      if (added) persistNow();
      const items = rows.map((o) => ({ ...recipientView(o, at), playerName: findPlayer(o.playerId)?.name ?? null }));
      res.json({ items, note: 'Offers issued to you, as the club issued them. Read the exact revision; accept or decline before it expires. Accepting in ScoutBox is not a signing.' });
    };
  }

  function readHandler(by) {
    return (req, res) => {
      const actorId = by === 'guardian' ? req.guardian.id : req.player.id;
      const playerIds = by === 'guardian' ? req.guardian.childIds : [req.player.id];
      const o = recipientOffer(req, res, { by, actorId, playerIds });
      if (!o) return;
      const at = now(req);
      markViewed(o, { kind: by, id: actorId }, at);
      res.json({ offer: recipientView(o, at), history: offerHistoryView(o, { forRecipient: true }) });
    };
  }

  /**
   * ACCEPT / DECLINE (§22, §23): explicit, exact revision, own act. Order:
   * concealing lookup → the recipient rule NOW (an adult player; a guardian
   * still controlling this child; the minor pathway) → the block rule
   * (decline is closure and allowed; accept is not) → the exact revision
   * gate → rev → rate → append the response → the case through the ONE
   * validator with the recipient as actor.
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
      if (typeof revisionId !== 'string' || !revisionId) return err(res, 'OFFER_INPUT_INVALID', 'Name the exact revision you are answering (revisionId).', { field: 'revisionId' });
      // Replay: the same key produced this exact response already.
      const priorResp = key.key ? (o.responses ?? []).find((x) => x && x.clientKey === key.key) : null;
      if (priorResp) {
        if (priorResp.revisionId === revisionId && priorResp.responseType === responseType && priorResp.actorId === actorId) return res.json({ offer: recipientView(o, at), lifecycle: o.lifecycle ?? null, idempotent: true });
        return err(res, 'OFFER_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different answer.');
      }
      // The recipient rule NOW.
      const player = findPlayer(o.playerId);
      const org = orgOf(o.orgId) ?? { id: o.orgId };
      const r = resolveContactRecipient({ player, org, guardians: db.guardians ?? [], isAdult, visibleToOrg, isBlocked, now: new Date(at) });
      const blocked = !r.ok && r.error === 'CONTACT_BLOCKED';
      if (!r.ok && !blocked) return err(res, 'OFFER_RECIPIENT_INVALID', by === 'guardian' ? 'You are no longer the verified guardian route for this player.' : 'This Offer is not yours to answer.');
      if (!blocked) {
        if (r.recipient.type !== by) return err(res, 'OFFER_RECIPIENT_INVALID', by === 'guardian' ? 'This player now answers their own Offers.' : 'This Offer is answered by your parent or guardian.');
        if (by === 'guardian' && r.recipient.guardianId !== actorId) return err(res, 'OFFER_RECIPIENT_INVALID', 'You are no longer the verified guardian route for this player.');
        if (r.recipient.minor && !minorOfferPathwayOpen(org.country ?? 'GB')) return err(res, 'OFFER_RECIPIENT_INVALID', 'No jurisdiction policy for an Offer to a minor is encoded in this build.');
      }
      if (blocked && responseType === 'accepted') return err(res, 'OFFER_BLOCKED', 'You have blocked this organisation. Lift the block before accepting an Offer from it; you may decline it.');
      const gate = canRespondToRevision(o, revisionId, at);
      if (!gate.ok) return err(res, gate.error, gate.message ?? 'This revision cannot be answered.');
      const rev = gate.revision;
      if (!responderMatches(rev, { kind: by, actorId, playerId: o.playerId })) return err(res, 'OFFER_RECIPIENT_INVALID', 'This revision was not addressed to you.');
      if (expectedRevOf(req.body) !== null) {
        const rawRev = req.body?.expectedRev ?? req.body?.expectedVersion;
        if (!Number.isInteger(rawRev) || rawRev < 0) return err(res, 'OFFER_REV_REQUIRED', 'expectedRev must be a non-negative integer.', { field: 'expectedRev', expected: 'integer' });
        if (!guardRev(req, res, o, { errorCode: 'OFFER_REV_CONFLICT', current: { rev: o.rev, status: effectiveRevisionStatus(rev, at) } })) return;
      }
      const reasonRaw = req.body?.reason;
      if (reasonRaw !== undefined && reasonRaw !== null && (typeof reasonRaw !== 'string' || reasonRaw.length > OFFER_LIMITS.declineReason)) return err(res, 'OFFER_INPUT_INVALID', `A reason is text under ${OFFER_LIMITS.declineReason} characters.`, { field: 'reason' });
      const reason = responseType === 'declined' && typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : null;
      if (reason && !moderateOrRefuse(res, reason, { kind: 'offer_decline', playerId: o.playerId })) return;
      if (limited('offer_response', `${by}:${actorId}`)) return res.status(429).json(rateLimitedBody('offer_response'));

      const who = { kind: by, id: actorId, name: actorName };
      const response = { id: nextId('rofa'), revisionId: rev.id, responseType, actorType: by, actorId, actorName, forPlayerId: o.playerId, occurredAt: at, reason, clientKey: key.key };
      // The club may have a NEW DRAFT open beside the live revision (§25). The
      // recipient's answer to the live revision is authoritative: the unissued
      // draft is discarded (it was never anyone's Offer), and the answered
      // revision becomes the current one. Recorded, never silent.
      const draftBeside = currentRevision(o);
      const discard = draftBeside && draftBeside.id !== rev.id && draftBeside.status === 'DRAFT' ? draftBeside : null;
      const before = { status: rev.status, offerStatus: o.status, currentRevisionId: o.currentRevisionId };
      o.responses.push(response);
      rev.status = responseType === 'accepted' ? 'ACCEPTED' : 'DECLINED';
      rev.respondedAt = at; rev.response = { id: response.id };
      if (discard) { discard.status = 'WITHDRAWN'; discard.withdrawnAt = at; discard.withdrawnBy = null; discard.withdrawReason = null; discard.discardedByResponseId = response.id; o.currentRevisionId = rev.id; }
      o.status = rev.status;
      const rollback = () => { o.responses.splice(o.responses.indexOf(response), 1); rev.status = before.status; rev.respondedAt = null; rev.response = null; o.status = before.offerStatus; o.currentRevisionId = before.currentRevisionId; if (discard) { discard.status = 'DRAFT'; discard.withdrawnAt = null; delete discard.discardedByResponseId; } };
      // The case moves BECAUSE the recipient acted — through the ONE validator, which now sees this response as its evidence.
      const room = (db.recruitmentCases ?? []).find((k) => k?.id === o.caseId && k.orgId === o.orgId) ?? null;
      let moved = { applied: false, action: null, reason: 'no_case', at };
      if (room) {
        moved = advanceCase({ room, action: responseType === 'accepted' ? 'recordOfferAccepted' : 'recordOfferDeclined', at, trigger: `offer:${responseType}:${o.id}`, actor: who, keyDetail: { offerId: o.id, revisionId: rev.id } });
        if (!moved.applied && moved.reason !== 'already_there') {
          // The case is somewhere an answer cannot move it (on hold, withdrawn…). The Offer is not answered into a state the case cannot record.
          rollback();
          return err(res, 'OFFER_LIFECYCLE_CONFLICT', 'This Offer cannot be answered right now; the club has paused or ended the case. Nothing was recorded.', { lifecycle: moved.reason });
        }
      }
      o.lifecycle = moved;
      o.updatedAt = at;
      bumpRev(rev, { by: null, at });
      bumpRev(o, { by: null, at });
      if (discard) hist(o, 'offer_draft_discarded', who, { revisionId: discard.id, byResponseId: response.id }, at);
      hist(o, responseType === 'accepted' ? 'offer_accepted' : 'offer_declined', who, { revisionId: rev.id, responseId: response.id, hadReason: !!reason }, at);
      if (room) audit(room, by, actorId, actorName, responseType === 'accepted' ? 'offer_accepted' : 'offer_declined', { offerId: o.id, revisionId: rev.id, to: moved.applied ? moved.to : undefined });
      persistNow();
      if (room) broadcast?.('offer_responded', { orgId: o.orgId, roomId: room.id, offerId: o.id, status: rev.status });
      notifyClub(o, `${actorName} ${responseType} Offer revision ${rev.revisionNumber} for ${room?.playerName ?? player?.name ?? 'the player'}${responseType === 'accepted' ? ' — accepted in ScoutBox; signing pending' : ''}.`);
      notifyAgent(o, `Your client ${player?.name ?? ''} ${responseType} the Offer from ${org.name ?? 'the club'}.`.replace(/\s+/g, ' '));
      res.json({ offer: recipientView(o, at), lifecycle: moved, signing: { created: false, note: 'Accepting an Offer in ScoutBox is not a signing. Nothing was signed and no contract exists.' } });
    };
  }

  /** An adult client shares ONE Offer with their currently representing agent (§12, §33). A guardian route cannot share. */
  playerRouter.post('/offers/:id/share-agent', (req, res) => {
    const o = recipientOffer(req, res, { by: 'player', actorId: req.player.id, playerIds: [req.player.id] });
    if (!o) return;
    const at = now(req);
    if (!isAdult(req.player)) return err(res, 'OFFER_NOT_PERMITTED', 'Sharing an Offer with an agent is an adult client\'s own act.');
    const sole = integration?.soleActiveAgentFor?.(req.player.id, at) ?? { agreement: null, ambiguous: false };
    const agreementId = typeof req.body?.agreementId === 'string' ? req.body.agreementId : null;
    let agreement = sole.agreement;
    if (agreementId) agreement = (db.representationAgreements ?? []).find((a) => a && a.id === agreementId && a.clientId === req.player.id && integration?.basisFor?.({ agentUserId: a.agentUserId, clientId: req.player.id, at })?.ok) ?? null;
    if (!agreement) return err(res, 'OFFER_INPUT_INVALID', sole.ambiguous ? 'You have more than one active agent. Name the agreement (agreementId) you are sharing with.' : 'No active representation agreement to share with.', { field: 'agreementId' });
    if (req.body?.share === false) {
      o.agentShare = null;
      hist(o, 'offer_agent_share_withdrawn', { kind: 'player', id: req.player.id, name: req.player.name }, null, at);
    } else {
      o.agentShare = { agentUserId: agreement.agentUserId, agreementId: agreement.id, at, by: { kind: 'player', id: req.player.id } };
      hist(o, 'offer_agent_shared', { kind: 'player', id: req.player.id, name: req.player.name }, { agreementId: agreement.id }, at);
      notify({ kind: 'org_user', id: agreement.agentUserId }, 'recruitment_offer', `${req.player.name} shared an Offer with you to read. Their answer is their own act.`, o.id);
    }
    // A share is the recipient's own fact about their agent: it changes no term
    // and must not make the club's next edit conflict. No rev bump.
    o.updatedAt = at;
    persistNow();
    res.json({ offer: recipientView(o, at) });
  });

  function documentHandler(by) {
    return (req, res) => {
      const actorId = by === 'guardian' ? req.guardian.id : req.player.id;
      const playerIds = by === 'guardian' ? req.guardian.childIds : [req.player.id];
      const o = recipientOffer(req, res, { by, actorId, playerIds });
      if (!o) return;
      // Only a document on an ISSUED (or answered) revision addressed to this recipient; never a draft's.
      const rev = (o.revisions ?? []).find((r) => wasIssued(r) && (r.documents ?? []).some((d) => d.id === req.params.docId));
      const doc = rev ? rev.documents.find((d) => d.id === req.params.docId) : null;
      if (!doc) return documentNotFound(res, by);
      const ev = (db.verEvidence ?? []).find((e) => e && e.id === doc.evidenceId && e.orgId === o.orgId);
      if (!ev) return documentNotFound(res, by);
      const blob = ev.mediaId && storage?.read ? storage.read(ev.mediaId) : null;
      res.json({ document: { id: doc.id, label: doc.label ?? null, mime: ev.mime ?? blob?.contentType ?? null, bytes: ev.bytes ?? blob?.buffer?.length ?? null, filename: ev.filename ?? null }, file: blob ? { mime: ev.mime ?? blob.contentType, base64: blob.buffer.toString('base64') } : null });
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

  // ================================================================== AGENT

  /**
   * Read-only projection (§12, §42): only Offers the client explicitly shared,
   * and only while the agent's basis, scope and licence hold NOW — the
   * `client_private` decision of P5.6E plus an employment/transfer scope. A
   * same-agency colleague, an agency administrator and an agent whose mandate
   * lapsed all see nothing, and nothing says an Offer exists (§33).
   */
  orgRouter.get('/agent/clients/:id/offers', (req, res) => {
    if (!agent?.resolveMembership?.(req, res)) return;
    const found = agent.findOwnAgreement(req, res, req.params.id);
    if (!found) return;
    if (found.summaryOnly) return res.status(403).json({ error: 'AGENT_ACTION_NOT_PERMITTED', message: 'A summary row does not open a client\'s Offers.' });
    const a = found;
    const at = now(req);
    const decision = integration?.decide?.({ surface: 'client_private', clientId: a.clientId, agentUserId: req.orgUser.id, at }) ?? { allowed: false, code: 'BASIS' };
    if (decision.allowed !== true) return res.status(403).json({ error: decision.code, rule: decision.rule ?? null, message: 'This client\'s Offers are not open to you right now.' });
    const basis = integration?.basisFor?.({ agentUserId: req.orgUser.id, clientId: a.clientId, at });
    const scopeOk = !!basis?.ok && (basis.scope ?? []).some((s) => s === 'employment' || s === 'transfer');
    if (!scopeOk) return res.status(403).json({ error: 'SCOPE_INSUFFICIENT', message: 'Your representation scope with this client does not cover employment or transfer.' });
    const player = findPlayer(a.clientId);
    const items = [];
    for (const o of db.recruitmentOffers ?? []) {
      if (!o || o.playerId !== a.clientId || offerIntegrity(o).length) continue;
      if (!o.agentShare || o.agentShare.agentUserId !== req.orgUser.id) continue; // not shared with THIS agent: invisible
      if (!liveRevision(o)) continue;
      items.push(offerAgentView(o, at, { orgName: orgOf(o.orgId)?.name ?? null }));
    }
    items.sort((x, y) => (y.sharedAt ?? 0) - (x.sharedAt ?? 0));
    res.json({
      items, clientId: a.clientId, clientName: player && orgCanSee(req.org, player) ? player.name : null,
      note: 'Only the Offers your client chose to share with you, as the club issued them. Accepting or declining is your client\'s own act; ScoutBox does not let you do it on their behalf.',
      honest: 'Nothing here is a negotiation, a fee or a signing. An accepted Offer is not a signed contract.',
    });
  });

  return {
    offerEvidenceReady: true,
    offersOfCase,
  };
}
