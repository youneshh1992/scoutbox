/**
 * Signing routes and `recordCompletedSigning`, the only writer of a completed signing.
 *
 * Offer accepted → package opened (club act) → exact document attached → presented (READY) → each required
 * party completes against the exact revision → completion → lifecycle `signed` → `under_contract`.
 * Nobody signs for someone else, and no body field names the actor, their role or a time.
 */

import { buildRouteHelpers } from '../../platform/routeHelpers.mjs';
import { requestClock } from '../../platform/clock.mjs';
import { roomRole } from '../rooms/shared.mjs';
import { limitCheck } from '../../platform/rateLimit.mjs';
import { NULL_EVIDENCE_PROVIDER } from '../lifecycle/lifecycle.mjs';
// The current-package rule (live → completed → newest terminal).
import { currentSigningForOffer } from '../lifecycle/journeyModel.mjs';
import { sendSigningError } from './errors.mjs';
import { currentRevision, effectiveStatus } from './signing.mjs';
import { strictContext } from '../../platform/deps.mjs';
import { createSigningShared } from './shared.mjs';
import { registerClubRoutes } from './clubRoutes.mjs';
import { registerCompletionRoutes } from './completionRoutes.mjs';
import { registerRecipientRoutes } from './recipientRoutes.mjs';
import { registerAgentRoutes } from './agentRoutes.mjs';
import { registerAdminRoutes } from './adminRoutes.mjs';

export function registerSigning(rawCtx) {
  const all = { ...rawCtx, ...buildRouteHelpers(rawCtx) };
  const {
    orgRouter,
    playerRouter,
    guardianRouter,
    adminRouter,
    nextId,
    notify,
    broadcast,
    findPlayer,
    isBlocked,
    rateLimit,
    isLead,
    auditEntry,
    orgCanSee,
    storage,
    ledgerAppend,
    billing = null,
    refreshJourneyBadges = null,
    isAdult = null,
    access = null,
    integration = null,
    evidence = null,
    faults = null,
    players,
    unit,
    afterCommit,
    signingsFollowUps,
    recruitmentReads,
    // A grassroots signing's squad row lives in org_squad_members.
    clubSetup,
    // The document vault.
    verificationReads,
    applyLifecycleTransition,
    findRoomForRequest,
    safetyReads,
    recruitmentCases,
  } = all;
  const vaultRecordOf = (id, orgId) => {
    const e = typeof id === 'string' ? (verificationReads?.evidence.byId(id) ?? null) : null;
    return e && e.orgId === orgId ? e : null;
  };
  if (typeof recruitmentReads?.offers?.byId !== 'function')
    throw new TypeError('registerSigning needs recruitmentReads (offers) from the data layer');
  const offerReads = recruitmentReads.offers;
  const caseOfOrg = (id, orgId) => {
    const k = recruitmentReads.cases.byId(id);
    return k && k.orgId === orgId ? k : null;
  };
  const caseAudit = (kase, ...entry) => recruitmentCases.cases.recordAct(kase.id, { history: [auditEntry(...entry)] });
  if (typeof players?.setAvailability !== 'function' || typeof unit !== 'function' || typeof afterCommit !== 'function')
    throw new TypeError(
      'registerSigning needs the identity repository (players), unit and afterCommit from the data layer',
    );
  if (
    typeof signingsFollowUps?.signingPackages?.insert !== 'function' ||
    typeof signingsFollowUps?.signings?.record !== 'function'
  )
    throw new TypeError('registerSigning needs the signings/follow-ups repository from the data layer');
  const sp = signingsFollowUps.signingPackages;
  const sg = signingsFollowUps.signings;

  /** Raised inside the completion unit: the unit rolls back and the route answers with this code. */
  class SigningAbort extends Error {
    constructor(code, message, { why = code, moved = null } = {}) {
      super(why);
      this.code = code;
      this.userMessage = message;
      this.moved = moved;
    }
  }

  const err = (res, error, message, extra = {}) => sendSigningError(res, { error, message, ...extra }, 'signing');
  const limited = limitCheck(rateLimit);
  const roleFor = (req, room) => roomRole({ room, user: req.orgUser, isLead: isLead(req.orgUser) });
  const evidenceProvider = () => all.recruitmentEvidenceProvider ?? NULL_EVIDENCE_PROVIDER;
  const orgOf = (orgId) => all.byId.org(orgId);
  const now = requestClock();
  const byOrg = (req) => ({ kind: 'org', id: req.orgUser.id, name: req.orgUser.name, role: req.orgUser.role ?? null });
  const hist = (pkg, action, by, detail, at) =>
    sp.addHistory(pkg.id, {
      id: nextId('aud'),
      at,
      action,
      by: { kind: by.kind, id: by.id ?? null, name: by.name ?? null },
      detail: detail ?? null,
    });
  const keyList = (pkg, act) =>
    Array.isArray(pkg.keys?.[act]) ? pkg.keys[act] : pkg.keys?.[act] ? [pkg.keys[act]] : [];
  const keyRow = (pkg, act, k) => keyList(pkg, act).find((x) => x && x.key === k) ?? null;
  const addKey = (pkg, act, entry) => sp.addKey(pkg.id, act, entry);
  /** bumpRev's rule (domains/platform/concurrency.mjs), written through the repository. */
  const touch = (pkg, req, at, by = req?.orgUser ?? null) =>
    sp.patch(pkg.id, {
      rev: (Number.isInteger(pkg.rev) ? pkg.rev : 1) + 1,
      revAt: at,
      revBy: by ? { userId: by.id ?? null, name: by.name ?? null } : null,
      updatedAt: at,
    });

  // Each part adds what it offers the later ones, so the parts are created in this order and register their routes in
  // it. Reading a name a part has not been given yet throws outside production.
  const parts = {
    orgRouter,
    playerRouter,
    guardianRouter,
    adminRouter,
    nextId,
    notify,
    broadcast,
    findPlayer,
    isBlocked,
    rateLimit,
    isLead,
    auditEntry,
    orgCanSee,
    storage,
    ledgerAppend,
    billing,
    refreshJourneyBadges,
    isAdult,
    access,
    integration,
    evidence,
    faults,
    players,
    unit,
    afterCommit,
    signingsFollowUps,
    recruitmentReads,
    clubSetup,
    verificationReads,
    applyLifecycleTransition,
    findRoomForRequest,
    safetyReads,
    recruitmentCases,
    vaultRecordOf,
    offerReads,
    caseOfOrg,
    caseAudit,
    sp,
    sg,
    SigningAbort,
    err,
    limited,
    roleFor,
    evidenceProvider,
    orgOf,
    now,
    byOrg,
    hist,
    keyList,
    keyRow,
    addKey,
    touch,
  };
  const ctx = strictContext('registerSigning', parts);
  const { recordCompletedSigning, legacyRecordingBlocker, packagesOf, packagesOfCase, soundPackage } = Object.assign(
    parts,
    createSigningShared(ctx),
  );
  registerClubRoutes(ctx);
  Object.assign(parts, registerCompletionRoutes(ctx));
  registerRecipientRoutes(ctx);
  registerAgentRoutes(ctx);
  registerAdminRoutes(ctx);

  // ================================================================== hooks

  /** Names nulled, records kept. */
  function onPlayerDeleted(playerId, at) {
    // Inside the deletion unit.
    sp.redactPlayer(playerId, at);
  }

  /** Identity-free: ids and the status word. */
  function summaryForOffer(offerId, orgId, at = Date.now()) {
    const rows = packagesOf(offerId, orgId).filter((p) => soundPackage(p, at));
    const live = currentSigningForOffer(rows, at);
    if (!live) return null;
    const rev = currentRevision(live);
    return {
      signingPackageId: live.id,
      status: effectiveStatus(live, at),
      revisionNumber: rev?.revisionNumber ?? null,
      presented: !!rev?.readyAt,
      completedAt: live.completion?.completedAt ?? null,
      signingId: live.completion?.signingId ?? null,
    };
  }

  return {
    recordCompletedSigning,
    legacyRecordingBlocker,
    onPlayerDeleted,
    summaryForOffer,
    packagesOfCase: (kase, at = Date.now()) => packagesOfCase(kase).filter((p) => soundPackage(p, at)),
  };
}
