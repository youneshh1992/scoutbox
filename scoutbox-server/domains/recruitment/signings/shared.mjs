/**
 * What the signing routes share: the lookups, the input and concurrency gates, the documents, the coupling to the
 * case's lifecycle, the notices and `recordCompletedSigning`, the only writer of a completed signing.
 */

import { PLANS } from '../../../catalogue.mjs';
import { createHash } from 'node:crypto';
import { roomCan } from '../rooms/shared.mjs';
import { guardRev, expectedRevOf } from '../../platform/concurrency.mjs';
import { parseInput } from '../../platform/schemas.mjs';
import { canTransitionRecruitmentCase, RECRUITMENT_LIFECYCLE_POLICY_VERSION } from '../lifecycle/lifecycle.mjs';
import { playerLevelAfterSigning } from '../../../domain.mjs';
import { offerStatus as canonicalOfferStatus } from '../offers/offer.mjs';
import { sendSigningError, notFound } from './errors.mjs';
import {
  SIGNING_POLICY_VERSION,
  SIGNING_LIMITS,
  cleanText,
  normaliseSigningClientKey,
  effectiveStatus,
  isLive,
  signingIntegrity,
  signingConsistency,
  signingCorrupt,
  completedSigningRecord,
  SIGNING_INPUT_CODES,
} from './signing.mjs';

export function createSigningShared(ctx) {
  const {
    afterCommit,
    applyLifecycleTransition,
    billing,
    broadcast,
    byOrg,
    caseOfOrg,
    joinSquad,
    err,
    evidence,
    evidenceProvider,
    findPlayer,
    findRoomForRequest,
    integration,
    isBlocked,
    isLead,
    keyRow,
    ledgerAppend,
    nextId,
    notify,
    now,
    offerReads,
    orgOf,
    playerRecord,
    recruitmentReads,
    refreshJourneyBadges,
    roleFor,
    safetyReads,
    sg,
    signingsFollowUps,
    sp,
    storage,
    vaultRecordOf,
  } = ctx;
  const caseOf = (pkg) => caseOfOrg(pkg.caseId, pkg.orgId);
  const offerOf = (pkg) => {
    const o = offerReads.byId(pkg.offerId);
    return o && o.orgId === pkg.orgId ? o : null;
  };
  const offerRevisionOf = (offer, id) => (offer?.revisions ?? []).find((r) => r && r.id === id) ?? null;
  const packagesOf = (offerId, orgId) => sp.forOffer(offerId).filter((p) => p.orgId === orgId);
  const packagesOfCase = (kase) => sp.forCase(kase.id).filter((p) => p.orgId === kase.orgId);
  const subjectRemoved = (kase) => !!kase?.subjectRemovedAt || !findPlayer(kase?.playerId);
  const completedRowFor = (pkg) => sg.forPackage(pkg.id);

  const consistencyOf = (pkg, offer, kase, at, look = LOOKUPS) =>
    signingConsistency(
      pkg,
      { offer, kase, rows: [look.rowFor(pkg.id)].filter(Boolean), player: look.playerOf(pkg.playerId) ?? null },
      at,
    );
  const LOOKUPS = Object.freeze({
    offerOf,
    caseOf,
    rowFor: (id) => sg.forPackage(id),
    playerOf: (id) => findPlayer(id),
  });
  /** The same lookups, answered from the players' offers, cases and signings read once. */
  function lookupsForPlayers(playerIds) {
    const pids = [...new Set(playerIds)];
    const offers = new Map(offerReads.forPlayers(pids).map((o) => [o.id, o]));
    const cases = new Map(pids.flatMap((pid) => recruitmentReads.cases.forPlayer(pid)).map((k) => [k.id, k]));
    const rows = new Map(
      pids
        .flatMap((pid) => sg.forPlayer(pid))
        .filter((r) => r.signingPackageId)
        .map((r) => [r.signingPackageId, r]),
    );
    const players = new Map(pids.map((pid) => [pid, findPlayer(pid) ?? null]));
    return Object.freeze({
      offerOf: (pkg) => {
        const o = offers.get(pkg.offerId) ?? offerReads.byId(pkg.offerId);
        return o && o.orgId === pkg.orgId ? o : null;
      },
      caseOf: (pkg) => {
        const k = cases.get(pkg.caseId) ?? recruitmentReads.cases.byId(pkg.caseId);
        return k && k.orgId === pkg.orgId ? k : null;
      },
      rowFor: (id) => rows.get(id) ?? sg.forPackage(id),
      playerOf: (id) => (players.has(id) ? players.get(id) : findPlayer(id)),
    });
  }
  /** Omitted from every projection unless its Offer, case and completed record agree with it. */
  function soundPackage(pkg, at, look = LOOKUPS) {
    if (!pkg || signingIntegrity(pkg).length) return false;
    const offer = look.offerOf(pkg);
    const kase = look.caseOf(pkg);
    if (!offer || !kase) return false;
    const c = consistencyOf(pkg, offer, kase, at, look);
    if (signingCorrupt(c)) {
      console.error(`SIGNING consistency ${pkg.id}: ${c.join(',')}`);
      return false;
    }
    return true;
  }

  function roomFor(req, res, need) {
    const room = findRoomForRequest(req, res);
    if (!room) return null;
    const role = roleFor(req, room);
    if (!roomCan(role, need)) {
      err(
        res,
        'SIGNING_NOT_PERMITTED',
        need === 'offer_view'
          ? 'Your role cannot read signings on this case.'
          : 'Only a room lead or recruitment lead can manage a signing.',
      );
      return null;
    }
    return { room, role };
  }

  /** A sound package of this organisation, or concealed. `need`: 'view' | 'manage' | 'lead'. */
  function packageFor(req, res, need) {
    const found = sp.byId(req.params.id);
    const pkg = found && found.orgId === req.org.id ? found : null;
    if (!pkg) {
      notFound(res, 'club');
      return null;
    }
    const problems = signingIntegrity(pkg, { orgId: req.org.id });
    if (problems.length) {
      console.error(`SIGNING integrity ${pkg.id}: ${problems.join(',')}`);
      err(res, 'SIGNING_STATE_UNKNOWN', 'This signing cannot be read.');
      return null;
    }
    const kase = caseOf(pkg);
    const offer = offerOf(pkg);
    if (!kase || !kase.room || !offer) {
      notFound(res, 'club');
      return null;
    }
    const consistency = consistencyOf(pkg, offer, kase, now(req));
    if (signingCorrupt(consistency)) {
      console.error(`SIGNING consistency ${pkg.id}: ${consistency.join(',')}`);
      err(res, 'SIGNING_STATE_UNKNOWN', 'This signing cannot be read.');
      return null;
    }
    const role = roleFor(req, kase);
    if (!roomCan(role, 'offer_view')) {
      err(res, 'SIGNING_NOT_PERMITTED', 'Your role cannot read signings on this case.');
      return null;
    }
    if (need === 'manage' && !roomCan(role, 'offer_issue')) {
      err(res, 'SIGNING_NOT_PERMITTED', 'Only a room lead or recruitment lead can manage a signing.');
      return null;
    }
    if (need === 'lead' && !isLead(req.orgUser)) {
      err(res, 'SIGNING_NOT_PERMITTED', 'Only a recruitment lead can sign for the club or complete a signing.');
      return null;
    }
    return { pkg, kase, offer, role, consistency };
  }

  /** The request input read with its schema, or `undefined` once the refusal is sent. */
  function signingInput(res, schema, input, { root = 'body' } = {}) {
    const parsed = parseInput(schema, input ?? {}, { ...SIGNING_INPUT_CODES, root });
    if (parsed.ok) return parsed.value;
    sendSigningError(res, parsed, 'signing');
    return undefined;
  }
  /** Cleaned text, or `undefined` once the refusal is sent. Measured after cleaning, as the stored value is. */
  function textOrRefuse(res, field, raw, max, { required = false } = {}) {
    const c = cleanText(raw, max);
    if (!c.ok) {
      err(res, 'SIGNING_INPUT_INVALID', `${field} must be at most ${max} characters.`, {
        field,
        problem: 'too_long',
        max,
      });
      return undefined;
    }
    if (required && !c.value) {
      err(res, 'SIGNING_INPUT_INVALID', `${field} is required.`, { field, problem: 'required' });
      return undefined;
    }
    return c.value;
  }

  /** The schema has checked any rev's shape; this requires one and compares it. */
  function revGate(req, res, record, body) {
    if (expectedRevOf(body) === null) {
      err(res, 'SIGNING_REV_REQUIRED', 'expectedRev is required: send the rev you were looking at.', {
        field: 'expectedRev',
        problem: 'required',
      });
      return false;
    }
    return guardRev(req, res, record, {
      errorCode: 'SIGNING_REV_CONFLICT',
      current: { rev: Number.isInteger(record.rev) ? record.rev : 1, status: record.status },
    });
  }

  function clientKey(res, body) {
    const k = normaliseSigningClientKey(body.clientKey);
    if (!k.ok) {
      err(res, k.error, k.message);
      return undefined;
    }
    return k.key;
  }
  const replayOr = (pkg, act, key, fp, res, view) => {
    if (!key) return false;
    const row = keyRow(pkg, act, key);
    if (!row) return false;
    if (row.fp === fp) {
      res.json({ ...view(), idempotent: true });
      return true;
    }
    err(res, 'SIGNING_IDEMPOTENCY_CONFLICT', 'This clientKey was already used for a different request.');
    return true;
  };

  // ------------------------------------------------------------- documents

  /** Through the evidence upload path: digest, sniffed type, size limit; organisation-internal. */
  function storeDocument(req, res, { pkg, kind, body }) {
    const { dataUrl, filename } = body;
    if (!evidence?.storeFile || !evidence?.add) {
      err(res, 'SIGNING_STORE_MISSING', 'Documents cannot be stored right now.');
      return null;
    }
    const label = textOrRefuse(res, 'label', body.label, SIGNING_LIMITS.label);
    if (label === undefined) return null;
    const stored = evidence.storeFile(dataUrl, filename, req);
    if (stored?.error) {
      err(res, 'SIGNING_DOCUMENT_INVALID', `The file was refused: ${stored.error}.`, {
        field: 'dataUrl',
        reasons: [stored.error],
      });
      return null;
    }
    // The digest a party will confirm is computed from the bytes that arrived and must equal the vault's.
    const m = /^data:[^;]+;base64,(.+)$/s.exec(dataUrl);
    const digest = m ? createHash('sha256').update(Buffer.from(m[1], 'base64')).digest('hex') : null;
    if (!digest || digest !== stored.sha256) {
      console.error(`SIGNING digest_mismatch vault=${stored.sha256} bytes=${digest}`);
      err(
        res,
        'SIGNING_DOCUMENT_INVALID',
        'The stored document digest does not match its bytes; the document was not attached.',
        { field: 'dataUrl' },
      );
      return null;
    }
    // The vault row is written by the caller's unit, with the package change that names it; only the file is
    // stored before it.
    const record = () => {
      const ev = evidence.add(
        {
          type: 'document',
          source: 'club_upload',
          suppliedByKind: 'org_user',
          suppliedById: req.orgUser.id,
          orgId: req.org.id,
          claimIds: [],
          ...stored,
          visibility: 'organisation_internal',
          retention: 'until_signing_resolution',
          meta: { signingPackageId: pkg.id, signingDocumentKind: kind, label },
        },
        req,
      );
      return {
        id: nextId(kind === 'executed' ? 'sgx' : 'sgd'),
        evidenceId: ev.id,
        sha256: ev.sha256,
        filename: ev.filename ?? null,
        mime: ev.mime ?? null,
        bytes: ev.bytes ?? null,
        label,
        uploadedAt: now(req),
        uploadedBy: byOrg(req),
      };
    };
    return { record };
  }
  /**
   * Checked before presenting, before a party confirms, at completion and before serving: the vault row must be
   * this package's and its bytes must hash to the revision's digest. Anything else is refused, never repaired.
   */
  function documentBytesProblem(pkg, doc) {
    if (!doc?.evidenceId || !doc.sha256) return 'missing';
    const ev = vaultRecordOf(doc.evidenceId, pkg.orgId);
    if (!ev) return 'evidence_missing';
    if (ev.meta?.signingPackageId !== pkg.id) return 'foreign';
    if (ev.sha256 !== doc.sha256) return 'digest_mismatch';
    const blob = ev.mediaId && storage?.read ? storage.read(ev.mediaId) : null;
    if (!blob?.buffer) return 'bytes_missing';
    return createHash('sha256').update(blob.buffer).digest('hex') === doc.sha256 ? null : 'bytes_mismatch';
  }
  function documentFile(doc, orgId) {
    const ev = vaultRecordOf(doc?.evidenceId, orgId);
    if (!ev) return null;
    const blob = ev.mediaId && storage?.read ? storage.read(ev.mediaId) : null;
    return {
      document: {
        id: doc.id,
        label: doc.label ?? null,
        filename: ev.filename ?? null,
        mime: ev.mime ?? blob?.contentType ?? null,
        bytes: ev.bytes ?? blob?.buffer?.length ?? null,
        sha256: ev.sha256 ?? null,
      },
      file: blob ? { mime: ev.mime ?? blob.contentType, base64: blob.buffer.toString('base64') } : null,
    };
  }

  // ------------------------------------------------------------- lifecycle coupling

  function advanceCase({ req = null, room, action, at, trigger, actor = null, keyDetail = {} }) {
    const role = req && !actor ? roleFor(req, room) : 'recruitment_admin';
    const verdict = canTransitionRecruitmentCase(room, action, { role, evidence: evidenceProvider(), now: at });
    if (verdict.ok) {
      const org = orgOf(room.orgId);
      let effect;
      try {
        effect = applyLifecycleTransition({
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
        console.error(`SIGNING lifecycle_writer_threw ${action}: ${e?.message ?? e}`);
        return { applied: false, action, reason: 'writer_failed', from: room.room.status, to: null, at };
      }
      return { applied: true, action, from: effect.from, to: effect.to, at };
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

  // ------------------------------------------------------------- notifications

  const notifyPlayer = (pkg, text) => {
    if (!isBlocked(pkg.playerId, pkg.orgId))
      notify({ kind: 'player', id: pkg.playerId }, 'recruitment_signing', text, pkg.id);
  };
  function notifyClubLeads(pkg, text) {
    const room = caseOf(pkg);
    const ids = new Set([room?.ownerUserId, room?.room?.leadScoutUserId, pkg.createdBy?.id].filter(Boolean));
    for (const uid of ids) notify({ kind: 'org_user', id: uid }, 'recruitment_signing', text, pkg.id);
  }
  function notifyAgent(pkg, text) {
    const offer = offerOf(pkg);
    const s = offer?.agentShare;
    if (!s?.agentUserId) return;
    const basis = integration?.basisFor?.({ agentUserId: s.agentUserId, clientId: pkg.playerId, at: now() });
    if (basis?.ok) notify({ kind: 'org_user', id: s.agentUserId }, 'recruitment_signing', text, pkg.id);
  }

  // ================================================================== completed signing writer

  /**
   * The only place a recruitment signing records a completed signing and sets a player's contract status,
   * level, timeline, squad row, availability and success-fee invoice. Called by the completion and, for
   * non-Offer recruitments, the legacy route.
   *
   * Idempotent per package. Every write, the notices included, runs inside the caller's unit; the invoice is issued
   * after commit.
   */
  function recordCompletedSigning({ player, org, actor, at, pkg = null, rev = null, legacy = null }) {
    if (pkg) {
      const existing = completedRowFor(pkg);
      if (existing) return { signing: existing, duplicate: true };
      // One completed signing per Offer, whatever package claims it.
      const byOffer = pkg.offerId ? sg.forOffer(pkg.offerId) : null;
      if (byOffer) return { signing: byOffer, duplicate: true };
    }
    const events = safetyReads.ledger.forPlayerOrg(player.id, org.id);
    const first = events[0] ?? null;
    const windowMonths = PLANS[org.plan].attributionWindowMonths; // orgs.plan has a CHECK against the catalogue
    const windowEnds = first ? first.ts + windowMonths * 30.44 * 24 * 3600 * 1000 : null;
    const row = ledgerAppend({
      type: 'signing',
      playerId: player.id,
      orgId: org.id,
      orgName: org.name,
      userId: actor?.id ?? null,
      scoutName: actor?.name ?? null,
    });
    const ts = pkg ? at : row.ts;
    const attribution = { first, windowMonths, inside: first ? ts <= windowEnds : false };
    const id = nextId('sign');
    const signing = pkg
      ? completedSigningRecord({ id, pkg, rev, player, org, actor, at: ts, attribution })
      : {
          id,
          playerId: player.id,
          playerName: player.name,
          orgId: org.id,
          orgName: org.name,
          userId: actor?.id ?? null,
          scoutName: actor?.name ?? null,
          ts,
          signedAt: ts,
          firstQualifyingInteraction: first,
          attributionWindowMonths: windowMonths,
          insideAttributionWindow: attribution.inside,
          method: 'LEGACY_RECORDED',
          note: legacy?.note ?? null,
          signingPackageId: null,
          signingRevisionId: null,
          offerId: null,
          caseId: null,
          documentSha256: null,
          contract: null,
          policyVersion: SIGNING_POLICY_VERSION,
        };
    signingsFollowUps.signings.record(signing);
    // A provider call never runs inside the transaction, so a rolled-back completion never issues an invoice.
    if (signing.insideAttributionWindow && billing?.invoiceForSigning) {
      afterCommit(() =>
        Promise.resolve(billing.invoiceForSigning(signing, org)).catch((e) =>
          console.error(`BILLING invoice_failed signing=${signing.id}: ${e?.message ?? e}`),
        ),
      );
    }
    // Grassroots signings make semi-pros; academy/pro signings make pros.
    const levelBefore = player.level ?? 'amateur';
    const levelAfter = playerLevelAfterSigning(org.level);
    const year = String(new Date(ts).getFullYear());
    const timeline = [];
    const levelLines = [];
    if (levelBefore === 'amateur' && levelAfter === 'semi_pro') {
      timeline.push({ year, event: `Levelled up: amateur → semi-pro with ${org.name}` });
      levelLines.push([
        `⬆️ You're semi-pro. ${org.name} signed you — one step up the ladder, recorded forever on your pathway.`,
        `${player.name} levelled up: amateur → semi-pro with ${org.name}.`,
      ]);
    } else if (levelBefore !== 'pro' && levelAfter === 'pro') {
      timeline.push({ year, event: `Levelled up: ${levelBefore.replace('_', '-')} → pro with ${org.name}` });
      levelLines.push([
        `⬆️ Academy/pro level reached with ${org.name}. Your grassroots journey got you here.`,
        `${player.name} reached academy/pro level with ${org.name}.`,
      ]);
    }
    if (org.level === 'grassroots')
      joinSquad({
        orgId: org.id,
        playerId: player.id,
        name: player.name,
        position: player.position ?? null,
        source: 'signing',
        at: ts,
      });
    timeline.push({
      year,
      event: pkg
        ? `Signed with ${org.name} — signing completed in ScoutBox`
        : `Signed by ${org.name} — discovered on ScoutBox`,
    });
    // Written here and nowhere else for a recruitment signing.
    playerRecord.recordSigning(player.id, {
      level: levelAfter,
      contractStatus: 'under_contract',
      availability: 'not_seeking',
      timeline,
    });
    refreshJourneyBadges?.(player);
    for (const [pText, gText] of levelLines) {
      notify({ kind: 'player', id: player.id }, 'level_up', pText, player.id);
      if (player.guardianId) notify({ kind: 'guardian', id: player.guardianId }, 'level_up', gText, player.id);
    }
    notify(
      { kind: 'player', id: player.id },
      'signing',
      pkg
        ? `🎉 ${org.name}: your signing is completed. It's on your timeline.`
        : `🎉 ${org.name} recorded your signing. Congratulations — it's on your timeline.`,
      signing.id,
    );
    if (player.guardianId)
      notify(
        { kind: 'guardian', id: player.guardianId },
        'signing',
        `${org.name} ${pkg ? 'completed' : 'recorded'} ${player.name}'s signing.`,
        signing.id,
      );
    broadcast?.('players', { playerId: player.id });
    return { signing, duplicate: false };
  }

  /** An accepted Offer or any package between this club and player means the workflow owns the signing. */
  function legacyRecordingBlocker(playerId, orgId, at = Date.now()) {
    const offers = offerReads.forOrgPlayer(orgId, playerId);
    if (offers.some((o) => canonicalOfferStatus(o, at) === 'ACCEPTED'))
      return {
        error: 'SIGNING_CANONICAL_REQUIRED',
        message:
          'This player accepted a canonical Offer from your club: complete the signing through the signing workflow on the case.',
      };
    if (sp.forOrgPlayer(orgId, playerId).some((p) => isLive(p, at) || effectiveStatus(p, at) === 'COMPLETED'))
      return {
        error: 'SIGNING_CANONICAL_REQUIRED',
        message: 'A signing workflow exists for this player on your case: complete it there.',
      };
    return null;
  }

  return {
    caseOf,
    offerOf,
    offerRevisionOf,
    packagesOf,
    packagesOfCase,
    subjectRemoved,
    consistencyOf,
    lookupsForPlayers,
    soundPackage,
    roomFor,
    packageFor,
    signingInput,
    textOrRefuse,
    revGate,
    clientKey,
    replayOr,
    storeDocument,
    documentBytesProblem,
    documentFile,
    advanceCase,
    notifyPlayer,
    notifyClubLeads,
    notifyAgent,
    recordCompletedSigning,
    legacyRecordingBlocker,
  };
}
