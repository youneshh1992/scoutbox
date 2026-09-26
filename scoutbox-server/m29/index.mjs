/**
 * M23 P7 — Signing & Contract Completion: the routes and the ONE writer.
 *
 *   Offer accepted → package opened (explicit club act) → document attached
 *   (exact bytes, digest) → presented (READY) → each required party completes
 *   against the exact revision → canonical completion → `db.signings` written
 *   once → lifecycle `signed` → player `contractStatus: 'under_contract'`.
 *
 * Routes
 *   GET    /org/rooms/:id/signing                    packages of the case + what may happen next
 *   POST   /org/offers/:id/signing                   open a package over an ACCEPTED Offer revision
 *   GET    /org/signings/:id · /history · /document  the club reads its own
 *   PATCH  /org/signings/:id                         contract days / note, DRAFT only
 *   POST   /org/signings/:id/document                attach the exact document (DRAFT only)
 *   POST   /org/signings/:id/ready                   present it: READY
 *   POST   /org/signings/:id/parties/club/complete   the club signatory (a recruitment lead) completes
 *   POST   /org/signings/:id/executed-document       the executed document as evidence
 *   POST   /org/signings/:id/complete                the completion gate → the ONE writer
 *   POST   /org/signings/:id/cancel · /void · /supersede
 *   GET    /player/signings · /:id · /:id/document   the presented revision only
 *   POST   /player/signings/:id/complete             the player's own act
 *   GET    /guardian/signings…                       dormant (pathway closed)
 *   GET    /org/agent/clients/:id/signings           read-only, over Offers the client shared
 *   POST   /admin/signings/:id/void                  a NAMED reviewer voids; never a party
 *
 * Never here: a route that signs for someone else; a body field that names
 * the actor, their role, or a time; a write to `db.signings` outside
 * `recordCompletedSigning`; an accepted Offer turning into anything by itself.
 */

import { createHash } from 'node:crypto';
import { buildShared } from '../m12/shared.mjs';
import { roomRole, roomCan } from '../m17/shared.mjs';
import { guardRev, bumpRev, expectedRevOf } from '../m181/concurrency.mjs';
import { rateLimitedBody } from '../m181/rateLimit.mjs';
import { canTransitionRecruitmentCase, NULL_EVIDENCE_PROVIDER, RECRUITMENT_LIFECYCLE_POLICY_VERSION } from '../m23/lifecycle.mjs';
import { playerLevelAfterSigning } from '../domain.mjs';
import { offerStatus as canonicalOfferStatus, effectiveRevisionStatus } from '../m28/offer.mjs';
// M23 P8 §54 — the ONE current-package rule (live → completed → newest terminal).
import { currentSigningForOffer } from '../m23/journeyModel.mjs';
import { sendSigningError, notFound, documentNotFound } from './errors.mjs';
import {
  SIGNING_POLICY_VERSION, SIGNING_STATUSES, SIGNING_STATUS_LABELS, SIGNING_METHODS, SIGNING_LIMITS, PARTY_TYPES,
  MINOR_SIGNING_PATHWAY_ENABLED, minorSigningPathwayOpen,
  payloadFingerprint, cleanText, normaliseSigningClientKey, validateContractDates, validateExpiry, requiredPartiesFor,
  currentRevision, nextRevisionNumber, effectiveStatus, isLive, partiesComplete, findParty,
  canStart, canAttachDocument, canMarkReady, canCompleteParty, canCancel, canVoid, canSupersede, completionGate,
  signingIntegrity, signingConsistency, signingCorrupt,
  signingClubView, signingRecipientView, signingAgentView, signingHistoryView, completedSigningRecord,
} from './signing.mjs';

const TEST_CLOCK = process.env.SCOUTBOX_TEST_CLOCK === '1';

export function registerSigning(rawCtx) {
  const ctx = { ...rawCtx, ...buildShared(rawCtx) };
  const {
    db, orgRouter, playerRouter, guardianRouter, adminRouter, nextId, persistNow, notify, broadcast, findPlayer, isBlocked,
    rateLimit, isLead, audit, orgCanSee, storage, ledgerAppend, billing = null, refreshJourneyBadges = null, isAdult = null,
    agent = null, integration = null, evidence = null, faults = null,
  } = ctx;

  // The store is migration-guaranteed (m280_001_signing_workflow, schema 2308);
  // the `??=` is the boot-order guard every module keeps, never a backfill.
  db.signingPackages ??= [];

  const err = (res, error, message, extra = {}) => sendSigningError(res, { error, message, ...extra }, 'signing');
  const limited = (action, keyPart) => !!rateLimit?.limited(action, keyPart);
  const roleFor = (req, room) => roomRole({ room, user: req.orgUser, isLead: isLead(req.orgUser) });
  const evidenceProvider = () => ctx.recruitmentEvidenceProvider ?? NULL_EVIDENCE_PROVIDER;
  const orgOf = (orgId) => (db.orgs ?? []).find((o) => o && o.id === orgId) ?? null;
  const now = (req = null) => {
    if (TEST_CLOCK && req?.get) { const n = Number(req.get('x-scoutbox-test-clock')); if (Number.isFinite(n) && n > 0) return n; }
    return Date.now();
  };
  const byOrg = (req) => ({ kind: 'org', id: req.orgUser.id, name: req.orgUser.name, role: req.orgUser.role ?? null });
  const hist = (pkg, action, by, detail, at) => { pkg.history ??= []; pkg.history.push({ id: nextId('aud'), at, action, by: { kind: by.kind, id: by.id ?? null, name: by.name ?? null }, detail: detail ?? null }); };
  const keyList = (pkg, act) => { pkg.keys ??= {}; if (!Array.isArray(pkg.keys[act])) pkg.keys[act] = pkg.keys[act] ? [pkg.keys[act]] : []; return pkg.keys[act]; };
  const keyRow = (pkg, act, k) => keyList(pkg, act).find((x) => x && x.key === k) ?? null;
  const safe = (label, fn) => { try { return fn(); } catch (e) { console.error(`SIGNING side_effect_failed ${label}: ${e?.message ?? e}`); return undefined; } };
  const touch = (pkg, req, at) => { bumpRev(pkg, { by: req?.orgUser ?? null, at }); pkg.updatedAt = at; };

  function storeOr500(res) {
    if (!Array.isArray(db.signingPackages) || !Array.isArray(db.signings)) {
      console.error('SIGNING store_missing db.signingPackages or db.signings is absent or not a list');
      err(res, 'SIGNING_STORE_MISSING', 'Signings cannot be served right now.');
      return null;
    }
    return db.signingPackages;
  }

  // ------------------------------------------------------------- lookups

  const caseOf = (pkg) => (db.recruitmentCases ?? []).find((k) => k && k.id === pkg.caseId && k.orgId === pkg.orgId) ?? null;
  const offerOf = (pkg) => (db.recruitmentOffers ?? []).find((o) => o && o.id === pkg.offerId && o.orgId === pkg.orgId) ?? null;
  const offerRevisionOf = (offer, id) => (offer?.revisions ?? []).find((r) => r && r.id === id) ?? null;
  const packagesOf = (offerId, orgId) => (db.signingPackages ?? []).filter((p) => p && p.offerId === offerId && p.orgId === orgId);
  const packagesOfCase = (kase) => (db.signingPackages ?? []).filter((p) => p && p.caseId === kase.id && p.orgId === kase.orgId);
  const subjectRemoved = (kase) => !!kase?.subjectRemovedAt || !findPlayer(kase?.playerId);
  const completedRowFor = (pkg) => (db.signings ?? []).find((s) => s && s.signingPackageId === pkg.id) ?? null;

  const consistencyOf = (pkg, offer, kase, at) => signingConsistency(pkg, { offer, kase, rows: db.signings ?? null, player: findPlayer(pkg.playerId) ?? null }, at);
  /** A sound row whose Offer, case and completed record do not contradict it; anything else is omitted from every projection (the P6.1 rule). */
  function soundPackage(pkg, at) {
    if (!pkg || signingIntegrity(pkg).length) return false;
    const offer = offerOf(pkg); const kase = caseOf(pkg);
    if (!offer || !kase) return false;
    const c = consistencyOf(pkg, offer, kase, at);
    if (signingCorrupt(c)) { console.error(`SIGNING consistency ${pkg.id}: ${c.join(',')}`); return false; }
    return true;
  }

  function roomFor(req, res, need) {
    const room = ctx.findRoomForRequest(req, res);
    if (!room) return null;
    const role = roleFor(req, room);
    if (!roomCan(role, need)) { err(res, 'SIGNING_NOT_PERMITTED', need === 'offer_view' ? 'Your role cannot read signings on this case.' : 'Only a room lead or recruitment lead can manage a signing.'); return null; }
    return { room, role };
  }

  /** A package of THIS organisation, sound, with its case and its Offer — or concealed. `need`: 'view' | 'manage' | 'lead'. */
  function packageFor(req, res, need) {
    if (!storeOr500(res)) return null;
    const pkg = db.signingPackages.find((p) => p && p.id === req.params.id && p.orgId === req.org.id) ?? null;
    if (!pkg) { notFound(res, 'club'); return null; }
    const problems = signingIntegrity(pkg, { orgId: req.org.id });
    if (problems.length) { console.error(`SIGNING integrity ${pkg.id}: ${problems.join(',')}`); err(res, 'SIGNING_STATE_UNKNOWN', 'This signing cannot be read.'); return null; }
    const kase = caseOf(pkg); const offer = offerOf(pkg);
    if (!kase || !kase.room || !offer) { notFound(res, 'club'); return null; }
    const consistency = consistencyOf(pkg, offer, kase, now(req));
    if (signingCorrupt(consistency)) { console.error(`SIGNING consistency ${pkg.id}: ${consistency.join(',')}`); err(res, 'SIGNING_STATE_UNKNOWN', 'This signing cannot be read.'); return null; }
    const role = roleFor(req, kase);
    if (!roomCan(role, 'offer_view')) { err(res, 'SIGNING_NOT_PERMITTED', 'Your role cannot read signings on this case.'); return null; }
    if (need === 'manage' && !roomCan(role, 'offer_issue')) { err(res, 'SIGNING_NOT_PERMITTED', 'Only a room lead or recruitment lead can manage a signing.'); return null; }
    if (need === 'lead' && !isLead(req.orgUser)) { err(res, 'SIGNING_NOT_PERMITTED', 'Only a recruitment lead can sign for the club or complete a signing.'); return null; }
    return { pkg, kase, offer, role, consistency };
  }

  function revGate(req, res, record) {
    const exp = expectedRevOf(req.body);
    if (exp === null) { err(res, 'SIGNING_REV_REQUIRED', 'expectedRev is required: send the rev you were looking at.'); return false; }
    const raw = req.body?.expectedRev ?? req.body?.expectedVersion;
    if (!Number.isInteger(raw) || raw < 0) { err(res, 'SIGNING_REV_REQUIRED', 'expectedRev must be a non-negative integer.', { field: 'expectedRev', expected: 'integer' }); return false; }
    return guardRev(req, res, record, { errorCode: 'SIGNING_REV_CONFLICT', current: { rev: Number.isInteger(record.rev) ? record.rev : 1, status: record.status } });
  }

  function clientKey(req, res) {
    const k = normaliseSigningClientKey(req.body?.clientKey);
    if (!k.ok) { err(res, k.error, k.message); return undefined; }
    return k.key;
  }
  const replayOr = (pkg, act, key, fp, res, view) => {
    if (!key) return false;
    const row = keyRow(pkg, act, key);
    if (!row) return false;
    if (row.fp === fp) { res.json({ ...view(), idempotent: true }); return true; }
    err(res, 'SIGNING_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different request.');
    return true;
  };

  // ------------------------------------------------------------- documents (ONE upload path: m14)

  /** Store bytes through the m14 seam: digest, sniffed type, size limit; a vault row owned by this club, organisation-internal, never public. */
  function storeDocument(req, res, { pkg, kind }) {
    const { dataUrl, filename, label } = req.body ?? {};
    if (!evidence?.storeFile || !evidence?.add) { err(res, 'SIGNING_STORE_MISSING', 'Documents cannot be stored right now.'); return null; }
    if (typeof dataUrl !== 'string' || !dataUrl) { err(res, 'SIGNING_DOCUMENT_INVALID', 'Attach the document as a data URL.', { field: 'dataUrl' }); return null; }
    const lab = cleanText(label, SIGNING_LIMITS.label);
    if (!lab.ok) { err(res, 'SIGNING_INPUT_INVALID', 'The label must be short text.', { field: 'label' }); return null; }
    const stored = evidence.storeFile(dataUrl, filename, req);
    if (stored?.error) { err(res, 'SIGNING_DOCUMENT_INVALID', `The file was refused: ${stored.error}.`, { field: 'dataUrl', reasons: [stored.error] }); return null; }
    // Defence in depth (§21): the digest a party will confirm is computed here
    // from the exact bytes that arrived, and must equal what the vault recorded.
    const m = /^data:[^;]+;base64,(.+)$/s.exec(dataUrl);
    const digest = m ? createHash('sha256').update(Buffer.from(m[1], 'base64')).digest('hex') : null;
    if (!digest || digest !== stored.sha256) { console.error(`SIGNING digest_mismatch vault=${stored.sha256} bytes=${digest}`); err(res, 'SIGNING_DOCUMENT_INVALID', 'The stored document digest does not match its bytes; the document was not attached.', { field: 'dataUrl' }); return null; }
    const ev = evidence.add({
      type: 'document', source: 'club_upload', suppliedByKind: 'org_user', suppliedById: req.orgUser.id, orgId: req.org.id, claimIds: [],
      ...stored, visibility: 'organisation_internal', retention: 'until_signing_resolution',
      meta: { signingPackageId: pkg.id, signingDocumentKind: kind, label: lab.value },
    }, req);
    return { id: nextId(kind === 'executed' ? 'sgx' : 'sgd'), evidenceId: ev.id, sha256: ev.sha256, filename: ev.filename ?? null, mime: ev.mime ?? null, bytes: ev.bytes ?? null, label: lab.value, uploadedAt: now(req), uploadedBy: byOrg(req) };
  }
  /**
   * P7.1 §5–§7: the bytes in the vault ARE the document the parties confirm. Before a revision is presented, before a party
   * confirms, at completion and before the bytes are served, the vault row must be this package's own and the bytes must
   * hash to the digest on the revision and on the row. Anything else is corruption: refused, never repaired, never served.
   */
  function documentBytesProblem(pkg, doc) {
    if (!doc?.evidenceId || !doc.sha256) return 'missing';
    const ev = (db.verEvidence ?? []).find((e) => e && e.id === doc.evidenceId && e.orgId === pkg.orgId) ?? null;
    if (!ev) return 'evidence_missing';
    if (ev.meta?.signingPackageId !== pkg.id) return 'foreign';
    if (ev.sha256 !== doc.sha256) return 'digest_mismatch';
    const blob = ev.mediaId && storage?.read ? storage.read(ev.mediaId) : null;
    if (!blob?.buffer) return 'bytes_missing';
    return createHash('sha256').update(blob.buffer).digest('hex') === doc.sha256 ? null : 'bytes_mismatch';
  }
  function documentFile(doc, orgId) {
    const ev = (db.verEvidence ?? []).find((e) => e && e.id === doc?.evidenceId && e.orgId === orgId);
    if (!ev) return null;
    const blob = ev.mediaId && storage?.read ? storage.read(ev.mediaId) : null;
    return { document: { id: doc.id, label: doc.label ?? null, filename: ev.filename ?? null, mime: ev.mime ?? blob?.contentType ?? null, bytes: ev.bytes ?? blob?.buffer?.length ?? null, sha256: ev.sha256 ?? null }, file: blob ? { mime: ev.mime ?? blob.contentType, base64: blob.buffer.toString('base64') } : null };
  }

  // ------------------------------------------------------------- lifecycle coupling (the ONE validator, the ONE writer)

  function advanceCase({ req = null, room, action, at, trigger, actor = null, keyDetail = {} }) {
    const role = req && !actor ? roleFor(req, room) : 'recruitment_admin';
    const verdict = canTransitionRecruitmentCase(room, action, { role, evidence: evidenceProvider(), now: at });
    if (verdict.ok) {
      const org = orgOf(room.orgId);
      let effect;
      try { effect = ctx.applyLifecycleTransition({ req, room, to: verdict.to, reasonCodes: [], trigger, actor: actor ? { ...actor, org } : null }); }
      catch (e) { console.error(`SIGNING lifecycle_writer_threw ${action}: ${e?.message ?? e}`); return { applied: false, action, reason: 'writer_failed', from: room.room.status, to: null, at }; }
      const last = room.history[room.history.length - 1];
      if (last?.action === 'room_status_changed') last.detail = { ...last.detail, lifecycleAction: action, clientKey: null, policyVersion: RECRUITMENT_LIFECYCLE_POLICY_VERSION, ...keyDetail };
      return { applied: true, action, from: effect.from, to: effect.to, at };
    }
    if (verdict.error === 'LIFECYCLE_NO_CHANGE') return { applied: false, action, reason: 'already_there', from: room.room.status, to: room.room.status, at };
    return { applied: false, action, reason: verdict.error, message: verdict.message ?? null, allowed: verdict.allowed ?? [], from: room.room.status, to: null, at };
  }

  // ------------------------------------------------------------- notifications

  const notifyPlayer = (pkg, text) => { if (!isBlocked(pkg.playerId, pkg.orgId)) notify({ kind: 'player', id: pkg.playerId }, 'recruitment_signing', text, pkg.id); };
  function notifyClubLeads(pkg, text) {
    const room = caseOf(pkg);
    const ids = new Set([room?.ownerUserId, room?.room?.leadScoutUserId, pkg.createdBy?.id].filter(Boolean));
    for (const uid of ids) notify({ kind: 'org_user', id: uid }, 'recruitment_signing', text, pkg.id);
  }
  function notifyAgent(pkg, text) {
    const offer = offerOf(pkg); const s = offer?.agentShare;
    if (!s?.agentUserId) return;
    const basis = integration?.basisFor?.({ agentUserId: s.agentUserId, clientId: pkg.playerId, at: now() });
    if (basis?.ok) notify({ kind: 'org_user', id: s.agentUserId }, 'recruitment_signing', text, pkg.id);
  }

  // ================================================================== THE ONE WRITER

  /**
   * The only function in the repository that appends to `db.signings` and the
   * only place a recruitment signing sets a player's `contractStatus`, level,
   * timeline, squad row, availability and success-fee invoice. Reached by the
   * canonical completion (with a package and its evidence) and, for legacy
   * non-Offer recruitments only, by the legacy route in server.mjs.
   *
   * Idempotent per package: a second call for the same package returns the
   * existing row and performs nothing. Authoritative writes happen first and
   * synchronously; the caller persists; notifications and broadcasts run after,
   * each under `safe()`.
   */
  function recordCompletedSigning({ player, org, actor, at, pkg = null, rev = null, legacy = null }) {
    if (pkg) {
      const existing = completedRowFor(pkg); if (existing) return { signing: existing, duplicate: true };
      // P7.1 §20, §29: one completed signing per Offer, whatever package claims it — a structural check, not a timing one.
      const byOffer = (db.signings ?? []).find((s) => s && s.offerId && s.offerId === pkg.offerId) ?? null; if (byOffer) return { signing: byOffer, duplicate: true };
    }
    const events = (db.ledger ?? []).filter((l) => l.playerId === player.id && l.orgId === org.id);
    const first = events[0] ?? null;
    const windowMonths = db.plans?.[org.plan]?.attributionWindowMonths ?? 18;
    const windowEnds = first ? first.ts + windowMonths * 30.44 * 24 * 3600 * 1000 : null;
    const row = ledgerAppend({ type: 'signing', playerId: player.id, orgId: org.id, orgName: org.name, userId: actor?.id ?? null, scoutName: actor?.name ?? null });
    const ts = pkg ? at : row.ts;
    const attribution = { first, windowMonths, inside: first ? ts <= windowEnds : false };
    const id = nextId('sign');
    const signing = pkg
      ? completedSigningRecord({ id, pkg, rev, player, org, actor, at: ts, attribution })
      : {
        id, playerId: player.id, playerName: player.name, orgId: org.id, orgName: org.name, userId: actor?.id ?? null, scoutName: actor?.name ?? null,
        ts, signedAt: ts, firstQualifyingInteraction: first, attributionWindowMonths: windowMonths, insideAttributionWindow: attribution.inside,
        method: 'LEGACY_RECORDED', note: legacy?.note ?? null, signingPackageId: null, signingRevisionId: null, offerId: null, caseId: null, documentSha256: null, contract: null, policyVersion: SIGNING_POLICY_VERSION,
      };
    db.signings.push(signing);
    // The revenue event: a signing inside the attribution window issues the success-fee invoice through the billing adapter — once per signing.
    if (signing.insideAttributionWindow && billing?.invoiceForSigning && !(db.invoices ?? []).some((i) => i?.signingId === signing.id)) void billing.invoiceForSigning(signing, org);
    // A signing moves the player's level: grassroots signings make semi-pros, academy/pro signings make pros.
    const levelBefore = player.level ?? 'amateur';
    player.level = playerLevelAfterSigning(org.level);
    player.timeline ??= [];
    const year = String(new Date(ts).getFullYear());
    const levelLines = [];
    if (levelBefore === 'amateur' && player.level === 'semi_pro') {
      player.timeline.push({ year, event: `Levelled up: amateur → semi-pro with ${org.name}` });
      levelLines.push([`⬆️ You're semi-pro. ${org.name} signed you — one step up the ladder, recorded forever on your pathway.`, `${player.name} levelled up: amateur → semi-pro with ${org.name}.`]);
    } else if (levelBefore !== 'pro' && player.level === 'pro') {
      player.timeline.push({ year, event: `Levelled up: ${levelBefore.replace('_', '-')} → pro with ${org.name}` });
      levelLines.push([`⬆️ Academy/pro level reached with ${org.name}. Your grassroots journey got you here.`, `${player.name} reached academy/pro level with ${org.name}.`]);
    }
    if (org.level === 'grassroots') {
      org.squad ??= [];
      if (!org.squad.some((e) => e.playerId === player.id)) org.squad.push({ id: nextId('sq'), playerId: player.id, name: player.name, position: player.position ?? '', source: 'signing', addedAt: ts });
    }
    // `under_contract` means a real contract was executed (M23_P7_CONTRACT_STATUS_SEMANTICS.md): written here and nowhere else for a recruitment signing.
    player.contractStatus = 'under_contract';
    player.availability = 'not_seeking';
    player.timeline.push({ year, event: pkg ? `Signed with ${org.name} — signing completed in ScoutBox` : `Signed by ${org.name} — discovered on ScoutBox` });
    const effects = () => {
      safe('refreshJourneyBadges', () => refreshJourneyBadges?.(player));
      for (const [pText, gText] of levelLines) {
        safe('notify_level_player', () => notify({ kind: 'player', id: player.id }, 'level_up', pText, player.id));
        if (player.guardianId) safe('notify_level_guardian', () => notify({ kind: 'guardian', id: player.guardianId }, 'level_up', gText, player.id));
      }
      safe('notify_signing_player', () => notify({ kind: 'player', id: player.id }, 'signing', pkg ? `🎉 ${org.name}: your signing is completed. It's on your timeline.` : `🎉 ${org.name} recorded your signing. Congratulations — it's on your timeline.`, signing.id));
      if (player.guardianId) safe('notify_signing_guardian', () => notify({ kind: 'guardian', id: player.guardianId }, 'signing', `${org.name} ${pkg ? 'completed' : 'recorded'} ${player.name}'s signing.`, signing.id));
      safe('broadcast_players', () => broadcast?.('players', { playerId: player.id }));
    };
    return { signing, duplicate: false, effects };
  }

  /**
   * The legacy route may record a signing only for a recruitment that never
   * went through the canonical Offer: an accepted Offer or any package between
   * this club and player means the canonical workflow owns the signing (§88).
   */
  function legacyRecordingBlocker(playerId, orgId, at = Date.now()) {
    const offers = (db.recruitmentOffers ?? []).filter((o) => o && o.orgId === orgId && o.playerId === playerId);
    if (offers.some((o) => canonicalOfferStatus(o, at) === 'ACCEPTED')) return { error: 'SIGNING_CANONICAL_REQUIRED', message: 'This player accepted a canonical Offer from your club: complete the signing through the signing workflow on the case.' };
    if ((db.signingPackages ?? []).some((p) => p && p.orgId === orgId && p.playerId === playerId && (isLive(p, at) || effectiveStatus(p, at) === 'COMPLETED'))) return { error: 'SIGNING_CANONICAL_REQUIRED', message: 'A signing workflow exists for this player on your case: complete it there.' };
    return null;
  }

  // ================================================================== CLUB

  function startBlockers(kase, role, at) {
    const blockers = [];
    if (!roomCan(role, 'offer_issue')) blockers.push('SIGNING_ROLE');
    if (subjectRemoved(kase)) blockers.push('SUBJECT_REMOVED');
    if (isBlocked(kase.playerId, kase.orgId)) blockers.push('BLOCKED');
    if (kase.room?.status !== 'offer_accepted') blockers.push('CASE_STATE');
    // §14: for a player under the age of majority the readiness names the closed pathway before anyone tries, whatever the Offer's state.
    const subject = findPlayer(kase.playerId);
    if (subject && typeof isAdult === 'function' && !isAdult(subject) && !minorSigningPathwayOpen(orgOf(kase.orgId)?.country ?? 'GB')) blockers.push('MINOR_PATHWAY_CLOSED');
    const accepted = (db.recruitmentOffers ?? []).find((o) => o && o.caseId === kase.id && o.orgId === kase.orgId && canonicalOfferStatus(o, at) === 'ACCEPTED') ?? null;
    if (!accepted) blockers.push('OFFER_NOT_ACCEPTED');
    else {
      const rev = (accepted.revisions ?? []).find((r) => r && effectiveRevisionStatus(r, at) === 'ACCEPTED') ?? null;
      if (rev?.recipientSnapshot?.type === 'guardian' && !minorSigningPathwayOpen(orgOf(kase.orgId)?.country ?? 'GB')) blockers.push('MINOR_PATHWAY_CLOSED');
      const existing = packagesOf(accepted.id, kase.orgId);
      if (existing.some((p) => effectiveStatus(p, at) === 'COMPLETED')) blockers.push('ALREADY_COMPLETED');
      else if (existing.some((p) => isLive(p, at))) blockers.push('PACKAGE_LIVE');
    }
    return { blockers: [...new Set(blockers)], accepted };
  }

  orgRouter.get('/rooms/:id/signing', (req, res) => {
    const got = roomFor(req, res, 'offer_view');
    if (!got) return;
    if (!storeOr500(res)) return;
    const { room: kase, role } = got;
    const at = now(req);
    const packages = packagesOfCase(kase).map((p) => ({ ...signingClubView(p, at, { orgName: orgOf(p.orgId)?.name ?? null }), integrity: [...signingIntegrity(p, { orgId: kase.orgId }), ...(offerOf(p) ? consistencyOf(p, offerOf(p), kase, at) : ['OFFER_MISSING'])] })).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const live = packagesOfCase(kase).find((p) => isLive(p, at)) ?? null;
    const { blockers, accepted } = startBlockers(kase, role, at);
    const legacySigning = (db.signings ?? []).find((s) => s && s.orgId === kase.orgId && s.playerId === kase.playerId && !s.signingPackageId) ?? null;
    res.json({
      packages, livePackageId: live?.id ?? null,
      legacySigning: legacySigning ? { id: legacySigning.id, at: legacySigning.ts ?? null, method: legacySigning.method ?? 'LEGACY_RECORDED' } : null,
      requirements: { role, canManage: roomCan(role, 'offer_issue'), canComplete: isLead(req.orgUser), status: kase.room?.status ?? null, startBlockers: blockers, acceptedOfferId: accepted?.id ?? null },
      vocabulary: { statuses: SIGNING_STATUSES, statusLabels: SIGNING_STATUS_LABELS, partyTypes: PARTY_TYPES, methods: SIGNING_METHODS, minorPathway: MINOR_SIGNING_PATHWAY_ENABLED },
      policyVersion: SIGNING_POLICY_VERSION,
      honest: 'An accepted Offer is not a signing. A signing is completed only when every required party has confirmed the exact document and a recruitment lead completes the package; only then does the case read Signed.',
    });
  });

  orgRouter.post('/offers/:id/signing', (req, res) => {
    if (!storeOr500(res)) return;
    const offer = (db.recruitmentOffers ?? []).find((o) => o && o.id === req.params.id && o.orgId === req.org.id) ?? null;
    if (!offer) return notFound(res, 'club');
    const kase = (db.recruitmentCases ?? []).find((k) => k && k.id === offer.caseId && k.orgId === req.org.id) ?? null;
    if (!kase || !kase.room) return notFound(res, 'club');
    const role = roleFor(req, kase);
    if (!roomCan(role, 'offer_view')) return err(res, 'SIGNING_NOT_PERMITTED', 'Your role cannot read signings on this case.');
    if (!roomCan(role, 'offer_issue')) return err(res, 'SIGNING_NOT_PERMITTED', 'Only a room lead or recruitment lead can open a signing.');
    const at = now(req);
    const key = clientKey(req, res); if (key === undefined) return;
    const b = req.body ?? {};
    const acceptedRev = (offer.revisions ?? []).find((r) => r && effectiveRevisionStatus(r, at) === 'ACCEPTED') ?? null;
    const contractIn = { startDate: b.contract?.startDate ?? acceptedRev?.terms?.startDate ?? null, endDate: b.contract?.endDate ?? acceptedRev?.terms?.endDate ?? null };
    const note = cleanText(b.internalNote, SIGNING_LIMITS.internalNote);
    if (!note.ok) return err(res, 'SIGNING_INPUT_INVALID', note.tooLong ? `Keep the note under ${SIGNING_LIMITS.internalNote} characters.` : 'The note must be text.', { field: 'internalNote' });
    const fp = payloadFingerprint({ offerId: offer.id, contract: contractIn, internalNote: note.value, expiresAt: b.expiresAt ?? null });
    if (key) {
      const prior = packagesOf(offer.id, req.org.id).find((p) => p.keys?.start?.key === key);
      if (prior) return prior.keys.start.fp === fp ? res.json({ signing: signingClubView(prior, at, { orgName: req.org.name }), idempotent: true }) : err(res, 'SIGNING_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different request.');
    }
    if (subjectRemoved(kase)) return err(res, 'SIGNING_SUBJECT_REMOVED', 'This player removed their ScoutBox account. No signing is opened about a person who left.');
    if (isBlocked(kase.playerId, kase.orgId)) return err(res, 'SIGNING_BLOCKED', 'This player (or their guardian) has blocked your organisation. No signing is opened while the block stands.');
    const gate = canStart({ offerStatus: canonicalOfferStatus(offer, at), offerRevisionStatus: acceptedRev ? effectiveRevisionStatus(acceptedRev, at) : null, caseStatus: kase.room?.status, recipientType: acceptedRev?.recipientSnapshot?.type ?? null, jurisdiction: orgOf(kase.orgId)?.country ?? 'GB', existing: packagesOf(offer.id, req.org.id) }, at);
    if (!gate.ok) return err(res, gate.error, gate.message, gate.current ? { current: gate.current } : {});
    if (offer.playerId !== kase.playerId) { console.error(`SIGNING offer/case player mismatch ${offer.id}`); return err(res, 'SIGNING_STATE_UNKNOWN', 'This Offer cannot be read.'); }
    const contract = validateContractDates(contractIn);
    if (!contract.ok) return err(res, contract.error, contract.message, { field: contract.field });
    const expiry = validateExpiry(b.expiresAt, { now: at });
    if (!expiry.ok) return err(res, expiry.error, expiry.message, { field: 'expiresAt', ...(expiry.expected ? { expected: expiry.expected } : {}) });
    if (limited('signing_start', req.org.id)) return res.status(429).json(rateLimitedBody('signing_start'));
    const by = byOrg(req);
    const rev = {
      id: nextId('spr'), revisionNumber: 1, status: 'DRAFT', createdAt: at, createdBy: by, readyAt: null, readyBy: null, completedAt: null,
      document: null, executedDocument: null, contract: contract.contract,
      requiredParties: requiredPartiesFor({ recipientType: acceptedRev.recipientSnapshot.type, playerId: kase.playerId, guardianId: acceptedRev.recipientSnapshot.guardianId ?? null, orgId: kase.orgId }),
      policySnapshot: { policyVersion: SIGNING_POLICY_VERSION, jurisdiction: orgOf(kase.orgId)?.country ?? 'GB', offerPolicyVersion: offer.policyVersion ?? null },
      supersedesRevisionId: null, supersededByRevisionId: null,
    };
    const pkg = {
      id: nextId('spk'), orgId: kase.orgId, caseId: kase.id, playerId: kase.playerId, offerId: offer.id, offerRevisionId: acceptedRev.id, transactionId: offer.transactionId ?? null,
      status: 'DRAFT', currentRevisionId: rev.id, revisions: [rev], expiresAt: expiry.ms, internalNote: note.value,
      keys: { start: key ? { key, fp } : null, ready: [], party: [], cancel: [], void: [], supersede: [], complete: [] },
      history: [], completion: null, cancelledAt: null, cancelledBy: null, cancelReason: null, voidedAt: null, voidedBy: null, voidReason: null,
      createdAt: at, createdBy: by, updatedAt: at, rev: 1, revAt: at, revBy: { userId: by.id, name: by.name }, policyVersion: SIGNING_POLICY_VERSION,
    };
    db.signingPackages.push(pkg);
    hist(pkg, 'signing_created', by, { revisionId: rev.id, offerId: offer.id, offerRevisionId: acceptedRev.id }, at);
    audit(kase, 'org', req.orgUser.id, req.orgUser.name, 'signing_created', { signingPackageId: pkg.id, offerId: offer.id });
    persistNow();
    safe('broadcast', () => broadcast?.('signing_created', { orgId: pkg.orgId, roomId: kase.id, signingPackageId: pkg.id, offerId: offer.id }));
    res.status(201).json({ signing: signingClubView(pkg, at, { orgName: req.org.name }) });
  });

  orgRouter.get('/signings/:id', (req, res) => {
    const got = packageFor(req, res, 'view'); if (!got) return;
    res.json({ signing: signingClubView(got.pkg, now(req), { orgName: req.org.name }), integrity: got.consistency });
  });
  orgRouter.get('/signings/:id/history', (req, res) => {
    const got = packageFor(req, res, 'view'); if (!got) return;
    res.json({ items: signingHistoryView(got.pkg), signingPackageId: got.pkg.id });
  });
  orgRouter.get('/signings/:id/document', (req, res) => {
    const got = packageFor(req, res, 'view'); if (!got) return;
    const which = req.query.kind === 'executed' ? 'executedDocument' : 'document';
    const revId = typeof req.query.revisionId === 'string' ? req.query.revisionId : got.pkg.currentRevisionId;
    const rev = (got.pkg.revisions ?? []).find((r) => r && r.id === revId);
    if (rev?.[which]) { const dp = documentBytesProblem(got.pkg, rev[which]); if (dp) { console.error(`SIGNING document_${dp} ${got.pkg.id} ${rev.id} ${which}`); return err(res, 'SIGNING_STATE_UNKNOWN', 'This document cannot be read.'); } }
    const out = rev?.[which] ? documentFile(rev[which], req.org.id) : null;
    if (!out) return documentNotFound(res, 'club');
    res.json(out);
  });

  orgRouter.patch('/signings/:id', (req, res) => {
    const got = packageFor(req, res, 'manage'); if (!got) return;
    const { pkg } = got; const at = now(req);
    const s = canAttachDocument(pkg, at); if (!s.ok) return err(res, s.error, s.message, s.current ? { current: s.current } : {});
    if (!revGate(req, res, pkg)) return;
    const b = req.body ?? {}; const rev = currentRevision(pkg);
    if (b.contract !== undefined) {
      const c = validateContractDates({ startDate: b.contract?.startDate ?? rev.contract?.startDate, endDate: b.contract?.endDate === undefined ? rev.contract?.endDate : b.contract?.endDate });
      if (!c.ok) return err(res, c.error, c.message, { field: c.field });
      rev.contract = c.contract;
    }
    if (b.internalNote !== undefined) {
      const note = cleanText(b.internalNote, SIGNING_LIMITS.internalNote);
      if (!note.ok) return err(res, 'SIGNING_INPUT_INVALID', 'The note must be short text.', { field: 'internalNote' });
      pkg.internalNote = note.value;
    }
    if (limited('signing_document_write', req.org.id)) return res.status(429).json(rateLimitedBody('signing_document_write'));
    hist(pkg, 'signing_draft_updated', byOrg(req), { revisionId: rev.id }, at);
    touch(pkg, req, at); persistNow();
    res.json({ signing: signingClubView(pkg, at, { orgName: req.org.name }) });
  });

  orgRouter.post('/signings/:id/document', (req, res) => {
    const got = packageFor(req, res, 'manage'); if (!got) return;
    const { pkg } = got; const at = now(req);
    const s = canAttachDocument(pkg, at); if (!s.ok) return err(res, s.error, s.message, s.current ? { current: s.current } : {});
    if (!revGate(req, res, pkg)) return;
    if (limited('signing_document_write', req.org.id)) return res.status(429).json(rateLimitedBody('signing_document_write'));
    const doc = storeDocument(req, res, { pkg, kind: 'signing' }); if (!doc) return;
    const rev = currentRevision(pkg);
    rev.document = doc;
    hist(pkg, 'signing_document_attached', byOrg(req), { revisionId: rev.id, sha256: doc.sha256 }, at);
    touch(pkg, req, at); persistNow();
    res.json({ signing: signingClubView(pkg, at, { orgName: req.org.name }) });
  });

  orgRouter.post('/signings/:id/ready', (req, res) => {
    const got = packageFor(req, res, 'manage'); if (!got) return;
    const { pkg, kase } = got; const at = now(req);
    const key = clientKey(req, res); if (key === undefined) return;
    const fp = payloadFingerprint({ expiresAt: req.body?.expiresAt ?? null });
    if (replayOr(pkg, 'ready', key, fp, res, () => ({ signing: signingClubView(pkg, at, { orgName: req.org.name }) }))) return;
    const s = canMarkReady(pkg, at); if (!s.ok) return err(res, s.error, s.message, { ...(s.current ? { current: s.current } : {}), ...(s.field ? { field: s.field } : {}) });
    if (!revGate(req, res, pkg)) return;
    if (isBlocked(pkg.playerId, pkg.orgId)) return err(res, 'SIGNING_BLOCKED', 'This player (or their guardian) has blocked your organisation. Nothing is presented while the block stands.');
    if (subjectRemoved(kase)) return err(res, 'SIGNING_SUBJECT_REMOVED', 'This player removed their ScoutBox account.');
    let expiresAt = pkg.expiresAt;
    if (req.body?.expiresAt !== undefined && req.body?.expiresAt !== null) { const e = validateExpiry(req.body.expiresAt, { now: at }); if (!e.ok) return err(res, e.error, e.message, { field: 'expiresAt' }); expiresAt = e.ms; }
    const rev = currentRevision(pkg);
    const dp = documentBytesProblem(pkg, rev.document);
    if (dp) { console.error(`SIGNING document_${dp} ${pkg.id} ${rev.id} at ready`); return err(res, 'SIGNING_STATE_UNKNOWN', 'This signing cannot be presented: its document cannot be verified.'); }
    if (limited('signing_document_write', req.org.id)) return res.status(429).json(rateLimitedBody('signing_document_write'));
    const by = byOrg(req);
    pkg.expiresAt = expiresAt;
    rev.status = 'READY'; rev.readyAt = at; rev.readyBy = by; pkg.status = 'READY';
    if (key) keyList(pkg, 'ready').push({ key, fp, revisionId: rev.id, at });
    hist(pkg, 'signing_ready', by, { revisionId: rev.id, sha256: rev.document.sha256 }, at);
    audit(kase, 'org', req.orgUser.id, req.orgUser.name, 'signing_ready', { signingPackageId: pkg.id, revisionId: rev.id });
    touch(pkg, req, at); persistNow();
    safe('broadcast', () => broadcast?.('signing_ready', { orgId: pkg.orgId, roomId: kase.id, signingPackageId: pkg.id, revisionId: rev.id }));
    safe('notify_player', () => notifyPlayer(pkg, `${req.org.name} has presented your contract for signing. Read the exact document in ScoutBox and confirm it when you are ready; nothing is signed until you do.`));
    safe('notify_agent', () => notifyAgent(pkg, `Your client ${findPlayer(pkg.playerId)?.name ?? ''} was presented a document to sign by ${req.org.name}. Their signature is their own act.`.replace(/\s+/g, ' ')));
    res.json({ signing: signingClubView(pkg, at, { orgName: req.org.name }) });
  });

  /** A party completion, shared by the player route and the club-signatory route. */
  function completeParty(req, res, { pkg, kase, partyType, actorKind, actorId, actorName, rateKey, orgName }) {
    const at = now(req);
    const key = clientKey(req, res); if (key === undefined) return;
    const b = req.body ?? {};
    const fp = payloadFingerprint({ partyType, revisionId: b.revisionId ?? null, documentSha256: b.documentSha256 ?? null });
    const view = () => (actorKind === 'org' ? { signing: signingClubView(pkg, at, { orgName }) } : { signing: signingRecipientView(pkg, at, { orgName, partyType, forEntityId: actorId }) });
    if (key) {
      const row = keyRow(pkg, 'party', key);
      // M23 P8.1 (D-P81-12): a replay is "the same signature" only while the
      // revision it signed is still the package's current one. After a
      // supersede voided that confirmation, the old key does not answer
      // `idempotent: true` as if the signature still stood.
      if (row) { if (row.fp === fp && row.actorId === actorId && (b.revisionId ?? null) === (pkg.currentRevisionId ?? null)) return res.json({ ...view(), idempotent: true }); return err(res, 'SIGNING_IDEMPOTENCY_CONFLICT', row.fp === fp && row.actorId === actorId ? 'This clientKey signed a revision that is no longer current; sign the current revision with a new key.' : 'This clientKey was already used for a different request.'); }
    }
    const method = b.method === undefined ? 'PLATFORM_ACKNOWLEDGMENT' : b.method;
    if (method !== 'PLATFORM_ACKNOWLEDGMENT') return err(res, 'SIGNING_METHOD_UNKNOWN', 'That signing method is not available here.', { allowed: ['PLATFORM_ACKNOWLEDGMENT'] });
    if (typeof b.revisionId !== 'string' || !b.revisionId) return err(res, 'SIGNING_INPUT_INVALID', 'Name the signing revision you are completing.', { field: 'revisionId' });
    if (typeof b.documentSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(b.documentSha256)) return err(res, 'SIGNING_INPUT_INVALID', 'Confirm the document by its SHA-256 digest as shown.', { field: 'documentSha256' });
    if (actorKind === 'org' && !revGate(req, res, pkg)) return;
    if (isBlocked(pkg.playerId, pkg.orgId)) return err(res, actorKind === 'org' ? 'SIGNING_BLOCKED' : 'SIGNING_STATE_INVALID', actorKind === 'org' ? 'This player (or their guardian) has blocked your organisation.' : 'This signing cannot be completed right now.');
    if (subjectRemoved(kase)) return err(res, 'SIGNING_SUBJECT_REMOVED', 'This player removed their ScoutBox account.');
    const g = canCompleteParty(pkg, { partyType, actorKind, actorId, revisionId: b.revisionId, documentSha256: b.documentSha256 }, at);
    if (!g.ok) return err(res, g.error, g.message, { ...(g.current ? { current: g.current } : {}), ...(g.field ? { field: g.field } : {}) });
    if (kase.room?.status !== 'offer_accepted') return err(res, 'SIGNING_LIFECYCLE_CONFLICT', 'The case is no longer at Offer accepted; the club must resolve it before signatures continue.', { current: { status: kase.room?.status ?? null } });
    { const dp = documentBytesProblem(pkg, g.revision.document); if (dp) { console.error(`SIGNING document_${dp} ${pkg.id} ${g.revision.id} at party completion`); return err(res, 'SIGNING_STATE_UNKNOWN', 'This signing cannot be confirmed: its document cannot be verified.'); } }
    if (limited('signing_party_completion', rateKey)) return res.status(429).json(rateLimitedBody('signing_party_completion'));
    const { revision: rev, party } = g;
    const by = { kind: actorKind, id: actorId, name: actorName };
    // P7.1 §36: a party completion is its own unit of work — the party, the statuses, the key, the history, the case audit
    // and the rev move together or not at all; a throw before persistence restores every one of them (no 500 with a party
    // completed in memory only).
    const snapshot = { party: JSON.stringify(party), revStatus: rev.status, pkgStatus: pkg.status, keys: keyList(pkg, 'party').length, history: (pkg.history ?? []).length, caseHistory: Array.isArray(kase.history) ? kase.history.length : null, rev: pkg.rev, revAt: pkg.revAt, revBy: pkg.revBy, updatedAt: pkg.updatedAt };
    try {
      party.status = 'COMPLETED'; party.completedAt = at; party.completedBy = by; party.method = 'PLATFORM_ACKNOWLEDGMENT';
      party.evidenceRef = { kind: 'platform_acknowledgment', id: nextId('sgev'), revisionId: rev.id, documentSha256: rev.document.sha256, at, actorKind, actorId, session: 'authenticated' };
      if (rev.status === 'READY') rev.status = 'IN_PROGRESS';
      if (pkg.status === 'READY') pkg.status = 'IN_PROGRESS';
      if (key) keyList(pkg, 'party').push({ key, fp, actorId, revisionId: rev.id, at });
      hist(pkg, 'signing_party_completed', by, { revisionId: rev.id, partyType, sha256: rev.document.sha256 }, at);
      audit(kase, actorKind, actorId, actorName, 'signing_party_completed', { signingPackageId: pkg.id, revisionId: rev.id, partyType });
      bumpRev(pkg, { by: actorKind === 'org' ? req.orgUser : { id: actorId, name: actorName }, at }); pkg.updatedAt = at;
      if (faults?.shouldFail?.('signing.party.after_write')) throw new Error('simulated failure after the party evidence write (development fault layer)');
      persistNow();
    } catch (e) {
      console.error(`SIGNING party_completion_rolled_back ${pkg.id}: ${e?.message ?? e}`);
      Object.assign(party, JSON.parse(snapshot.party));
      rev.status = snapshot.revStatus; pkg.status = snapshot.pkgStatus;
      keyList(pkg, 'party').length = snapshot.keys; if (Array.isArray(pkg.history)) pkg.history.length = snapshot.history;
      if (snapshot.caseHistory !== null) kase.history.length = snapshot.caseHistory;
      pkg.rev = snapshot.rev; pkg.revAt = snapshot.revAt; pkg.revBy = snapshot.revBy; pkg.updatedAt = snapshot.updatedAt;
      return err(res, 'SIGNING_STATE_UNKNOWN', 'The signature could not be recorded; nothing was recorded.');
    }
    safe('broadcast', () => broadcast?.('signing_party_completed', { orgId: pkg.orgId, roomId: kase.id, signingPackageId: pkg.id, revisionId: rev.id, partyType }));
    if (actorKind !== 'org') safe('notify_club', () => notifyClubLeads(pkg, `${actorName ?? 'The player'} confirmed the signing document for ${findPlayer(pkg.playerId)?.name ?? 'the player'}. ${partiesComplete(rev) ? 'Every required party has signed: a recruitment lead can now complete the signing.' : 'Waiting on the remaining party.'}`));
    else safe('notify_player', () => notifyPlayer(pkg, `${orgName} has signed for the club. ${partiesComplete(rev) ? 'Every required party has now signed; the club completes the signing next.' : 'Your signature is still needed.'}`));
    res.json(view());
  }

  orgRouter.post('/signings/:id/parties/club/complete', (req, res) => {
    const got = packageFor(req, res, 'lead'); if (!got) return;
    completeParty(req, res, { pkg: got.pkg, kase: got.kase, partyType: 'CLUB_SIGNATORY', actorKind: 'org', actorId: req.orgUser.id, actorName: req.orgUser.name, rateKey: `org:${req.orgUser.id}`, orgName: req.org.name });
  });

  orgRouter.post('/signings/:id/executed-document', (req, res) => {
    const got = packageFor(req, res, 'manage'); if (!got) return;
    const { pkg } = got; const at = now(req);
    const st = effectiveStatus(pkg, at);
    if (!['READY', 'IN_PROGRESS'].includes(st)) { const s = canVoid(pkg, at); return err(res, s.ok ? 'SIGNING_STATE_INVALID' : s.error, s.ok ? 'The executed document is attached to a presented signing.' : s.message, s.current ? { current: s.current } : {}); }
    if (!revGate(req, res, pkg)) return;
    if (limited('signing_document_write', req.org.id)) return res.status(429).json(rateLimitedBody('signing_document_write'));
    const doc = storeDocument(req, res, { pkg, kind: 'executed' }); if (!doc) return;
    const rev = currentRevision(pkg);
    rev.executedDocument = doc;
    hist(pkg, 'signing_executed_document_attached', byOrg(req), { revisionId: rev.id, sha256: doc.sha256 }, at);
    touch(pkg, req, at); persistNow();
    res.json({ signing: signingClubView(pkg, at, { orgName: req.org.name }) });
  });

  /**
   * The completion gate → the ONE writer → the ONE lifecycle writer, as one
   * unit: every authoritative write happens in memory first; if any step
   * refuses or throws, everything is restored from the snapshot and nothing
   * is persisted. Notifications and broadcasts run only after persistence.
   */
  orgRouter.post('/signings/:id/complete', (req, res) => {
    const got = packageFor(req, res, 'lead'); if (!got) return;
    const { pkg, kase, offer } = got; const at = now(req);
    const key = clientKey(req, res); if (key === undefined) return;
    const fp = payloadFingerprint({ complete: true });
    if (replayOr(pkg, 'complete', key, fp, res, () => ({ signing: signingClubView(pkg, at, { orgName: req.org.name }), lifecycle: pkg.completion?.lifecycle ?? null }))) return;
    if (pkg.status === 'COMPLETED') return err(res, 'SIGNING_ALREADY_COMPLETED', 'This signing is already completed.');
    if (!revGate(req, res, pkg)) return;
    const rev = currentRevision(pkg);
    const offerRev = offerRevisionOf(offer, pkg.offerRevisionId);
    const otherCompleted = packagesOf(pkg.offerId, pkg.orgId).some((p) => p.id !== pkg.id && effectiveStatus(p, at) === 'COMPLETED') || (db.signings ?? []).some((s) => s && s.offerId === pkg.offerId);
    const problems = completionGate(pkg, { documentProblem: rev?.document ? documentBytesProblem(pkg, rev.document) : 'missing', now: at, offer: offer ? { ...offer, status: canonicalOfferStatus(offer, at) } : null, offerRevision: offerRev ? { ...offerRev, status: effectiveRevisionStatus(offerRev, at) } : null, kase, otherCompleted, blocked: isBlocked(pkg.playerId, pkg.orgId) });
    if (problems.length) {
      const first = problems[0];
      if (first.startsWith('DOCUMENT_BYTES_')) { console.error(`SIGNING ${first.toLowerCase()} ${pkg.id} at completion`); return err(res, 'SIGNING_STATE_UNKNOWN', 'This signing cannot be completed: its document cannot be verified.'); }
      const code = first === 'EXPIRED' ? 'SIGNING_EXPIRED' : first === 'ALREADY_COMPLETED' ? 'SIGNING_ALREADY_COMPLETED' : first === 'STATE_VOIDED' ? 'SIGNING_VOIDED' : first === 'STATE_CANCELLED' ? 'SIGNING_CANCELLED' : first === 'PARTIES_INCOMPLETE' ? 'SIGNING_PARTIES_INCOMPLETE' : first === 'DOCUMENT_REQUIRED' ? 'SIGNING_DOCUMENT_REQUIRED' : first === 'DOCUMENT_MISMATCH' || first === 'EVIDENCE_INVALID' || first === 'TEMPORAL_ORDER' ? 'SIGNING_EVIDENCE_INVALID' : first === 'BLOCKED' ? 'SIGNING_BLOCKED' : first === 'LIFECYCLE_CONFLICT' ? 'SIGNING_LIFECYCLE_CONFLICT' : first === 'OFFER_NOT_ACCEPTED' || first === 'OFFER_REVISION_MISMATCH' ? 'SIGNING_OFFER_NOT_ACCEPTED' : first === 'CONFLICTING_COMPLETED_SIGNING' ? 'SIGNING_CONFLICT' : first.startsWith('STATE_') ? 'SIGNING_STATE_INVALID' : 'SIGNING_STATE_UNKNOWN';
      return err(res, code, 'The signing cannot be completed yet.', { blockers: problems, current: { status: effectiveStatus(pkg, at) } });
    }
    if (subjectRemoved(kase)) return err(res, 'SIGNING_SUBJECT_REMOVED', 'This player removed their ScoutBox account.');
    const player = findPlayer(pkg.playerId); const org = orgOf(pkg.orgId);
    if (!player || !org) return err(res, 'SIGNING_STATE_UNKNOWN', 'This signing cannot be completed.');
    if (limited('signing_closure', req.org.id)) return res.status(429).json(rateLimitedBody('signing_closure'));
    // ---- the unit of work
    // M23 P8 — the case part of the snapshot is the lifecycle writer's own
    // (status, stage, rev, instants, history length, links), not a bare status.
    const snapshot = { pkg: JSON.stringify(pkg), signingsLen: db.signings.length, ledgerLen: (db.ledger ?? []).length, invoicesLen: (db.invoices ?? []).length, player: JSON.stringify(player), squad: JSON.stringify(org.squad ?? null), caseStatus: kase.room.status, lifecycle: ctx.lifecycleSnapshot(kase) };
    const rollback = (why) => {
      console.error(`SIGNING completion_rolled_back ${pkg.id}: ${why}`);
      Object.assign(pkg, JSON.parse(snapshot.pkg));
      db.signings.length = snapshot.signingsLen;
      if (Array.isArray(db.ledger)) db.ledger.length = snapshot.ledgerLen;
      if (Array.isArray(db.invoices)) db.invoices.length = snapshot.invoicesLen;
      Object.assign(player, JSON.parse(snapshot.player));
      if (snapshot.squad !== 'null') org.squad = JSON.parse(snapshot.squad);
      ctx.restoreLifecycle(kase, snapshot.lifecycle);
    };
    const by = byOrg(req);
    let effects = null; let moved = null; let signing = null;
    try {
      rev.status = 'COMPLETED'; rev.completedAt = at; rev.completedBy = by;
      pkg.status = 'COMPLETED';
      const written = recordCompletedSigning({ player, org, actor: req.orgUser, at, pkg, rev });
      if (written.duplicate) { rollback('duplicate_row'); return err(res, 'SIGNING_ALREADY_COMPLETED', 'A completed signing record already exists for this package.'); }
      signing = written.signing; effects = written.effects;
      if (faults?.shouldFail?.('signing.complete.after_row')) throw new Error('simulated failure after the db.signings row (development fault layer)');
      pkg.completion = { signingId: signing.id, completedAt: at, completedBy: by, contract: rev.contract, documentSha256: rev.document.sha256, lifecycle: null };
      // The lifecycle asks the ONE validator with the real evidence provider — which now finds the row this completion just wrote.
      moved = advanceCase({ req, room: kase, action: 'confirmSignedOutcome', at, trigger: `signing:complete:${pkg.id}`, keyDetail: { signingPackageId: pkg.id, signingId: signing.id } });
      if (!moved.applied) { rollback(`lifecycle_${moved.reason}`); return err(res, 'SIGNING_LIFECYCLE_CONFLICT', moved.message ?? 'The case could not be moved to Signed; nothing was recorded.', { lifecycle: moved, current: { status: kase.room.status } }); }
      pkg.completion.lifecycle = { from: moved.from, to: moved.to, at };
      if (faults?.shouldFail?.('signing.complete.after_lifecycle')) throw new Error('simulated failure after the lifecycle moved (development fault layer)');
      kase.links ??= {}; kase.links.signingId = signing.id;
      if (key) keyList(pkg, 'complete').push({ key, fp, signingId: signing.id, at });
      hist(pkg, 'signing_completed', by, { revisionId: rev.id, signingId: signing.id, sha256: rev.document.sha256 }, at);
      audit(kase, 'org', req.orgUser.id, req.orgUser.name, 'signing_completed', { signingPackageId: pkg.id, signingId: signing.id, to: moved.to });
      touch(pkg, req, at);
      persistNow();
    } catch (e) {
      rollback(`threw ${e?.message ?? e}`);
      return err(res, 'SIGNING_STATE_UNKNOWN', 'The signing could not be completed; nothing was recorded.');
    }
    safe('effects', () => { if (faults?.shouldFail?.('signing.complete.effects')) throw new Error('simulated failure in the after-effects (development fault layer)'); effects?.(); });
    safe('broadcast', () => broadcast?.('signing_completed', { orgId: pkg.orgId, roomId: kase.id, signingPackageId: pkg.id, signingId: signing.id }));
    safe('notify_agent', () => notifyAgent(pkg, `${org.name} completed the signing for your client ${player.name}.`));
    safe('notify_club', () => notifyClubLeads(pkg, `Signing completed for ${player.name}. The case reads Signed.`));
    res.json({ signing: signingClubView(pkg, at, { orgName: req.org.name }), lifecycle: moved, signingId: signing.id });
  });

  function closeRoute(action) {
    return (req, res) => {
      const got = packageFor(req, res, action === 'cancel' ? 'manage' : 'lead'); if (!got) return;
      const { pkg, kase } = got; const at = now(req);
      const key = clientKey(req, res); if (key === undefined) return;
      const reason = cleanText(req.body?.reason, SIGNING_LIMITS.reason);
      if (!reason.ok) return err(res, 'SIGNING_INPUT_INVALID', 'The reason must be short text.', { field: 'reason' });
      const fp = payloadFingerprint({ action, reason: reason.value });
      if (replayOr(pkg, action, key, fp, res, () => ({ signing: signingClubView(pkg, at, { orgName: req.org.name }) }))) return;
      const g = (action === 'cancel' ? canCancel : canVoid)(pkg, at);
      if (!g.ok) return err(res, g.error, g.message, g.current ? { current: g.current } : {});
      if (!revGate(req, res, pkg)) return;
      if (limited('signing_safety_closure', req.org.id)) return res.status(429).json(rateLimitedBody('signing_safety_closure'));
      const by = byOrg(req); const rev = currentRevision(pkg);
      const status = action === 'cancel' ? 'CANCELLED' : 'VOIDED';
      pkg.status = status; rev.status = status;
      if (action === 'cancel') { pkg.cancelledAt = at; pkg.cancelledBy = by; pkg.cancelReason = reason.value; } else { pkg.voidedAt = at; pkg.voidedBy = by; pkg.voidReason = reason.value; }
      if (key) keyList(pkg, action).push({ key, fp, at });
      hist(pkg, `signing_${status.toLowerCase()}`, by, { revisionId: rev.id, hadReason: !!reason.value }, at);
      audit(kase, 'org', req.orgUser.id, req.orgUser.name, `signing_${status.toLowerCase()}`, { signingPackageId: pkg.id });
      touch(pkg, req, at); persistNow();
      // Literal event names: the boot-time registry scanner reads the source and cannot see a computed name (the P6 D-P6-9 lesson).
      if (action === 'cancel') safe('broadcast', () => broadcast?.('signing_cancelled', { orgId: pkg.orgId, roomId: kase.id, signingPackageId: pkg.id }));
      else safe('broadcast', () => broadcast?.('signing_voided', { orgId: pkg.orgId, roomId: kase.id, signingPackageId: pkg.id }));
      if (rev.readyAt) safe('notify_player', () => notifyPlayer(pkg, `${req.org.name} ${action === 'cancel' ? 'cancelled' : 'voided'} the signing presented to you. Nothing was signed. Your accepted Offer is unchanged.`));
      res.json({ signing: signingClubView(pkg, at, { orgName: req.org.name }) });
    };
  }
  orgRouter.post('/signings/:id/cancel', closeRoute('cancel'));
  orgRouter.post('/signings/:id/void', closeRoute('void'));

  /** The document changes: the presented revision is SUPERSEDED, a fresh DRAFT revision opens with the same contract days, every party pending again (§69). */
  orgRouter.post('/signings/:id/supersede', (req, res) => {
    const got = packageFor(req, res, 'manage'); if (!got) return;
    const { pkg, kase } = got; const at = now(req);
    const key = clientKey(req, res); if (key === undefined) return;
    const reason = cleanText(req.body?.reason, SIGNING_LIMITS.reason);
    if (!reason.ok) return err(res, 'SIGNING_INPUT_INVALID', 'The reason must be short text.', { field: 'reason' });
    const fp = payloadFingerprint({ supersede: true, reason: reason.value });
    if (replayOr(pkg, 'supersede', key, fp, res, () => ({ signing: signingClubView(pkg, at, { orgName: req.org.name }) }))) return;
    const g = canSupersede(pkg, at); if (!g.ok) return err(res, g.error, g.message, g.current ? { current: g.current } : {});
    if (!revGate(req, res, pkg)) return;
    if (limited('signing_document_write', req.org.id)) return res.status(429).json(rateLimitedBody('signing_document_write'));
    const by = byOrg(req); const prev = currentRevision(pkg);
    const acceptedRev = offerRevisionOf(got.offer, pkg.offerRevisionId);
    const rev = {
      id: nextId('spr'), revisionNumber: nextRevisionNumber(pkg), status: 'DRAFT', createdAt: at, createdBy: by, readyAt: null, readyBy: null, completedAt: null,
      document: null, executedDocument: null, contract: { ...prev.contract },
      requiredParties: requiredPartiesFor({ recipientType: acceptedRev?.recipientSnapshot?.type ?? 'player', playerId: pkg.playerId, guardianId: acceptedRev?.recipientSnapshot?.guardianId ?? null, orgId: pkg.orgId }),
      policySnapshot: { ...prev.policySnapshot }, supersedesRevisionId: prev.id, supersededByRevisionId: null,
    };
    prev.status = 'SUPERSEDED'; prev.supersededByRevisionId = rev.id; prev.supersededAt = at;
    pkg.revisions.push(rev); pkg.currentRevisionId = rev.id; pkg.status = 'DRAFT';
    if (key) keyList(pkg, 'supersede').push({ key, fp, revisionId: rev.id, at });
    hist(pkg, 'signing_superseded', by, { revisionId: rev.id, supersedes: prev.id, hadReason: !!reason.value }, at);
    audit(kase, 'org', req.orgUser.id, req.orgUser.name, 'signing_superseded', { signingPackageId: pkg.id, revisionId: rev.id, supersedes: prev.id });
    touch(pkg, req, at); persistNow();
    safe('broadcast', () => broadcast?.('signing_superseded', { orgId: pkg.orgId, roomId: kase.id, signingPackageId: pkg.id, revisionId: rev.id, supersedes: prev.id }));
    safe('notify_player', () => notifyPlayer(pkg, `${req.org.name} withdrew the document presented to you; any confirmation you gave no longer applies. A new document will be presented before anything is signed.`));
    res.status(201).json({ signing: signingClubView(pkg, at, { orgName: req.org.name }) });
  });

  // ================================================================== RECIPIENT

  /** Packages presented to this person, re-authorised live: the addressed adult, over an Offer they accepted, on a sound row. */
  function recipientPackages({ by, actorId, playerIds, at }) {
    const out = [];
    for (const p of db.signingPackages ?? []) {
      if (!p || !playerIds.includes(p.playerId) || !soundPackage(p, at)) continue;
      const rev = currentRevision(p);
      const presented = (p.revisions ?? []).some((r) => r && r.readyAt);
      if (!presented) continue; // a draft is invisible, not redacted
      const party = findParty(rev, by === 'guardian' ? 'GUARDIAN' : 'PLAYER');
      if (!party || party.forEntityId !== actorId) continue;
      if (by === 'guardian' && !minorSigningPathwayOpen(orgOf(p.orgId)?.country ?? 'GB')) continue; // dormant
      out.push(p);
    }
    return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }
  function recipientPackage(req, res, { by, actorId, playerIds }) {
    if (!storeOr500(res)) return null;
    const p = recipientPackages({ by, actorId, playerIds, at: now(req) }).find((x) => x.id === req.params.id) ?? null;
    if (!p) { notFound(res, by); return null; }
    return p;
  }
  const recipientView = (p, at, by, actorId) => signingRecipientView(p, at, { orgName: orgOf(p.orgId)?.name ?? null, partyType: by === 'guardian' ? 'GUARDIAN' : 'PLAYER', forEntityId: actorId });

  playerRouter.get('/signings', (req, res) => {
    if (!storeOr500(res)) return;
    const at = now(req);
    const items = recipientPackages({ by: 'player', actorId: req.player.id, playerIds: [req.player.id], at }).map((p) => recipientView(p, at, 'player', req.player.id));
    res.json({ items, note: 'Documents presented to you for signing, exactly as the club presented them. Confirming one records your signature on that exact document; nothing is signed until every required party has confirmed and the club completes the signing.' });
  });
  playerRouter.get('/signings/:id', (req, res) => {
    const p = recipientPackage(req, res, { by: 'player', actorId: req.player.id, playerIds: [req.player.id] }); if (!p) return;
    res.json({ signing: recipientView(p, now(req), 'player', req.player.id), history: signingHistoryView(p, { forRecipient: true }) });
  });
  playerRouter.get('/signings/:id/document', (req, res) => {
    const p = recipientPackage(req, res, { by: 'player', actorId: req.player.id, playerIds: [req.player.id] }); if (!p) return;
    const revId = typeof req.query.revisionId === 'string' ? req.query.revisionId : p.currentRevisionId;
    const rev = (p.revisions ?? []).find((r) => r && r.id === revId && r.readyAt);
    if (rev?.document) { const dp = documentBytesProblem(p, rev.document); if (dp) { console.error(`SIGNING document_${dp} ${p.id} ${rev.id}`); return err(res, 'SIGNING_STATE_UNKNOWN', 'This document cannot be read.'); } }
    const out = rev?.document ? documentFile(rev.document, p.orgId) : null;
    if (!out) return documentNotFound(res, 'player');
    res.json(out);
  });
  playerRouter.post('/signings/:id/complete', (req, res) => {
    const p = recipientPackage(req, res, { by: 'player', actorId: req.player.id, playerIds: [req.player.id] }); if (!p) return;
    const kase = caseOf(p);
    completeParty(req, res, { pkg: p, kase, partyType: 'PLAYER', actorKind: 'player', actorId: req.player.id, actorName: req.player.name ?? null, rateKey: `player:${req.player.id}`, orgName: orgOf(p.orgId)?.name ?? null });
  });

  // Guardian routes are dormant: the pathway is closed in every jurisdiction, so the list is empty and every act is refused.
  guardianRouter.get('/signings', (req, res) => { if (!storeOr500(res)) return; res.json({ items: [], note: 'Signing on behalf of a player under the age of majority is not open in this jurisdiction.' }); });
  guardianRouter.get('/signings/:id', (req, res) => notFound(res, 'guardian'));
  guardianRouter.get('/signings/:id/document', (req, res) => documentNotFound(res, 'guardian'));
  guardianRouter.post('/signings/:id/complete', (req, res) => {
    if (!storeOr500(res)) return;
    const p = recipientPackages({ by: 'guardian', actorId: req.guardian.id, playerIds: req.guardian.childIds ?? [], at: now(req) }).find((x) => x.id === req.params.id);
    if (!p) return notFound(res, 'guardian');
    return err(res, 'SIGNING_PATHWAY_CLOSED', 'Signing on behalf of a player under the age of majority is not open in this jurisdiction.');
  });

  // ================================================================== AGENT (read-only, re-authorised)

  orgRouter.get('/agent/clients/:id/signings', (req, res) => {
    if (!agent?.resolveMembership?.(req, res)) return;
    const found = agent.findOwnAgreement(req, res, req.params.id);
    if (!found) return;
    if (found.summaryOnly) return res.status(403).json({ error: 'AGENT_ACTION_NOT_PERMITTED', message: 'A summary row does not open a client\'s signings.' });
    if (!storeOr500(res)) return;
    const a = found; const at = now(req);
    const decision = integration?.decide?.({ surface: 'client_private', clientId: a.clientId, agentUserId: req.orgUser.id, at }) ?? { allowed: false, code: 'BASIS' };
    if (decision.allowed !== true) return res.status(403).json({ error: decision.code, rule: decision.rule ?? null, message: 'This client\'s signings are not open to you right now.' });
    const basis = integration?.basisFor?.({ agentUserId: req.orgUser.id, clientId: a.clientId, at });
    if (!basis?.ok || !(basis.scope ?? []).some((s) => s === 'employment' || s === 'transfer')) return res.status(403).json({ error: 'SCOPE_INSUFFICIENT', message: 'Your representation scope with this client does not cover employment or transfer.' });
    const licence = integration?.licenceCurrentFor ? integration.licenceCurrentFor(req.orgUser.id, a.jurisdiction ?? null, at) : false;
    if (licence !== true) return res.status(403).json({ error: 'LICENCE_NOT_CURRENT', rule: 'LICENCE', message: 'This client\'s signings are not open to you right now.' });
    const items = [];
    for (const p of db.signingPackages ?? []) {
      if (!p || p.playerId !== a.clientId || !soundPackage(p, at)) continue;
      const offer = offerOf(p);
      if (!offer?.agentShare || offer.agentShare.agentUserId !== req.orgUser.id) continue; // the client shares the Offer; the signing rides on that share
      if (!(p.revisions ?? []).some((r) => r && r.readyAt)) continue; // a draft is the club's own
      items.push(signingAgentView(p, at, { orgName: orgOf(p.orgId)?.name ?? null }));
    }
    const player = findPlayer(a.clientId);
    res.json({ items, clientId: a.clientId, clientName: player && orgCanSee(req.org, player) ? player.name : null, honest: 'Read-only. Your client signs as themselves; ScoutBox does not let you sign, acknowledge or complete for a client.' });
  });

  // ================================================================== T&S (explicit, audited, never a party)

  adminRouter.post('/signings/:id/void', (req, res) => {
    if (!storeOr500(res)) return;
    if (!req.reviewer?.id) return err(res, 'SIGNING_NOT_PERMITTED', 'Voiding a signing requires a named Trust & Safety reviewer.');
    const pkg = db.signingPackages.find((p) => p && p.id === req.params.id) ?? null;
    if (!pkg) return notFound(res, 'admin');
    const at = now(req);
    const reason = cleanText(req.body?.reason, SIGNING_LIMITS.reason);
    if (!reason.ok || !reason.value) return err(res, 'SIGNING_INPUT_INVALID', 'A recorded reason is required.', { field: 'reason' });
    const g = canVoid(pkg, at); if (!g.ok) { const g2 = canCancel(pkg, at); if (!g2.ok) return err(res, g2.error, g2.message, g2.current ? { current: g2.current } : {}); }
    const by = { kind: 'admin', id: req.reviewer.id, name: req.reviewer.name ?? req.reviewer.id };
    const rev = currentRevision(pkg);
    pkg.status = 'VOIDED'; rev.status = 'VOIDED'; pkg.voidedAt = at; pkg.voidedBy = by; pkg.voidReason = reason.value;
    hist(pkg, 'signing_voided', by, { revisionId: rev.id, hadReason: true, byTrustAndSafety: true }, at);
    const kase = caseOf(pkg); if (kase) audit(kase, 'admin', by.id, by.name, 'signing_voided', { signingPackageId: pkg.id, byTrustAndSafety: true });
    bumpRev(pkg, { by: { id: by.id, name: by.name }, at }); pkg.updatedAt = at; persistNow();
    safe('broadcast', () => broadcast?.('signing_voided', { orgId: pkg.orgId, roomId: pkg.caseId, signingPackageId: pkg.id }));
    safe('notify_club', () => notifyClubLeads(pkg, 'Trust & Safety voided a signing on one of your cases. Nothing was signed.'));
    if (rev.readyAt) safe('notify_player', () => notifyPlayer(pkg, 'The signing presented to you was voided by Trust & Safety. Nothing was signed.'));
    res.json({ ok: true, signingPackageId: pkg.id, status: 'VOIDED' });
  });

  // ================================================================== hooks

  /** Deletion: names nulled, the record kept (the P6.1 rule); no new write about a person who left. */
  function onPlayerDeleted(playerId, at) {
    for (const p of db.signingPackages ?? []) {
      if (!p || p.playerId !== playerId) continue;
      for (const r of p.revisions ?? []) for (const party of r?.requiredParties ?? []) if (party?.completedBy?.kind === 'player') party.completedBy.name = null;
      for (const h of p.history ?? []) if (h?.by?.kind === 'player') h.by.name = null;
      p.subjectRemovedAt = at;
    }
  }

  /** A minimal, identity-free summary for the Offer views and the journey: ids and the status word. */
  function summaryForOffer(offerId, orgId, at = Date.now()) {
    const rows = packagesOf(offerId, orgId).filter((p) => soundPackage(p, at));
    const live = currentSigningForOffer(rows, at);
    if (!live) return null;
    const rev = currentRevision(live);
    return { signingPackageId: live.id, status: effectiveStatus(live, at), revisionNumber: rev?.revisionNumber ?? null, presented: !!rev?.readyAt, completedAt: live.completion?.completedAt ?? null, signingId: live.completion?.signingId ?? null };
  }

  return { recordCompletedSigning, legacyRecordingBlocker, onPlayerDeleted, summaryForOffer, packagesOfCase: (kase, at = Date.now()) => packagesOfCase(kase).filter((p) => soundPackage(p, at)) };
}
