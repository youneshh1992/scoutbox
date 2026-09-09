// Milestone 14 registration point — Verification & Trust.
// Same architecture as m12/ and m13/: focused modules receive the shared
// server context and register on the EXISTING authenticated routers, so every
// standing gate (bearer sessions, org suspension, guardian ownership,
// visibleToOrg, blocks, moderation) runs before any M14 handler.
//
// Verification proves FACTS; authorization decides ACCESS. Nothing registered
// here loosens visibleToOrg, guardian routing, adult-only representation, the
// grassroots radius, or any other standing rule.
import crypto from 'node:crypto';
import {
  migrateM14, buildClaimIndex, applyTransition, effectiveStatus,
  toPublicVerificationProfile, hasVerLevel, verLevelFor, orgCanAttest,
  orgVerificationStatus, mintToken, consumeToken, sha256,
  evidenceFileProblem, claimProvenanceLabel,
} from './shared.mjs';
import { metrics } from '../m13/enterprise.mjs';
import { registerOrganisationVerification } from './organisations.mjs';
import { registerVerificationReview } from './review.mjs';

export function registerM14(ctx) {
  migrateM14(ctx.db);
  const { db, nextId, persist } = ctx;
  const idx = buildClaimIndex(db);

  // -------- verification metrics (§61): counters only, never names/emails.
  metrics.verification = {
    requestsCreated: 0, autoPrechecksPassed: 0, routedToHumanReview: 0,
    approvals: 0, rejections: 0, disputes: 0, expiries: 0, revocations: 0,
    emailChallengeFailures: 0,
  };
  const vmetric = (k) => { metrics.verification[k] = (metrics.verification[k] ?? 0) + 1; };

  // -------- append-only verification event log (§11).
  function verEvent(type, fields = {}, req = null) {
    const row = {
      id: nextId('vevt'), ts: Date.now(), type,
      actorKind: fields.actorKind ?? (req?.orgUser ? 'org_user' : 'system'),
      actorId: fields.actorId ?? req?.orgUser?.id ?? null,
      actorName: fields.actorName ?? req?.orgUser?.name ?? null,
      actorOrgId: fields.actorOrgId ?? req?.org?.id ?? null,
      requestId: req?.correlationId ?? null,
      claimId: fields.claimId ?? null, subjectId: fields.subjectId ?? null,
      orgId: fields.orgId ?? null, before: fields.before ?? null,
      after: fields.after ?? null, reason: fields.reason ?? null,
    };
    db.verEvents.push(row);
    return row;
  }

  // -------- claim construction. THE only creator: guarantees index upkeep.
  function createClaim(fields, req = null) {
    const now = Date.now();
    const claim = {
      id: nextId('vclm'), subjectType: 'user', organisationId: null, role: null,
      status: 'unverified', validFrom: null, validUntil: null, current: true,
      verificationMethod: null, authorityType: null, authorityId: null,
      evidenceIds: [], createdAt: now, updatedAt: now,
      verifiedAt: null, verifiedBy: null, revokedAt: null, revokedBy: null,
      revocationReason: null, suspendedAt: null, disputedAt: null,
      supersedesClaimId: null, reviewReasons: [], riskFlags: [], metadata: {},
      ...fields,
    };
    db.verClaims.push(claim);
    idx.register(claim);
    verEvent('claim.created', { claimId: claim.id, subjectId: claim.subjectId, orgId: claim.organisationId, after: { claimType: claim.claimType, status: claim.status } }, req);
    vmetric('requestsCreated');
    persist();
    return claim;
  }

  // -------- guarded transition: one call site shape for every status change.
  function transition(claim, to, opts, req = null) {
    const before = claim.status;
    const err = applyTransition(claim, to, opts);
    if (err) return err;
    verEvent(opts.eventType ?? `claim.${to}`, {
      claimId: claim.id, subjectId: claim.subjectId, orgId: claim.organisationId,
      actorKind: opts.actorKind, actorId: opts.actorId, actorName: opts.actorName,
      before: { status: before }, after: { status: to, method: claim.verificationMethod }, reason: opts.reason ?? null,
    }, req);
    if (to === 'verified') vmetric('approvals');
    if (to === 'rejected') vmetric('rejections');
    if (to === 'revoked') vmetric('revocations');
    if (to === 'expired') vmetric('expiries');
    if (to === 'disputed') vmetric('disputes');
    persist();
    return null;
  }

  // -------- evidence records (§12, §40). Files go through the same storage
  // engine as media but are NEVER exposed on public/static paths — retrieval
  // is a dedicated, authorised route in review.mjs.
  function addEvidence(fields, req = null) {
    const ev = {
      id: nextId('vevd'), receivedAt: Date.now(), claimIds: [], mediaId: null,
      sha256: null, mime: null, bytes: null, filename: null, meta: {},
      checks: { malwareScan: 'not_configured' }, // no scanner exists — never pretend one ran
      retention: 'until_claim_resolution', visibility: 'trust_and_safety',
      expiresAt: null, ...fields,
    };
    db.verEvidence.push(ev);
    verEvent('evidence.added', { claimId: ev.claimIds[0] ?? null, subjectId: ev.suppliedById, orgId: ev.orgId, after: { type: ev.type, sha256: ev.sha256 } }, req);
    persist();
    return ev;
  }
  function storeEvidenceFile(dataUrl, filename, req) {
    const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(String(dataUrl ?? ''));
    if (!m) return { error: 'BAD_DATA_URL' };
    const mime = m[1];
    const buf = Buffer.from(m[2], 'base64');
    const problem = evidenceFileProblem({ mime, bytes: buf.length, filename: filename ?? 'evidence' });
    if (problem) return { error: problem };
    const id = nextId('vfil');
    // sanitized server name = our own id; the original name is metadata only
    ctx.storage.saveDataUrl(id, `data:${mime};base64,${buf.toString('base64')}`);
    return { mediaId: id, sha256: sha256(buf), mime, bytes: buf.length, filename: String(filename ?? '').slice(0, 120) };
  }

  // -------- verification-permission guard (§9). Server-enforced; a disabled
  // button is never the control. Root-level operations additionally require
  // an MFA-enabled account (existing F12 infrastructure).
  function requireVer(req, res, atLeast, { root = false } = {}) {
    if (!hasVerLevel(db, req.org.id, req.orgUser.id, atLeast)) {
      res.status(403).json({ error: 'VERIFICATION_PERMISSION_REQUIRED', message: `This needs ${atLeast.replace(/_/g, ' ')} authority for your organisation.` });
      return false;
    }
    if (root && !req.orgUser.mfa?.enabledAt) {
      res.status(403).json({ error: 'MFA_REQUIRED_FOR_ROOT_OPERATION', message: 'Sensitive verification-authority operations require an account with MFA enabled (Organisation → Security).' });
      return false;
    }
    return true;
  }

  const orgsById = () => new Map(db.orgs.map((o) => [o.id, o]));

  function publicProfileForUser(userId, now = Date.now()) {
    const user = db.users.find((u) => u.id === userId);
    return toPublicVerificationProfile({
      subjectType: 'user', subjectId: userId,
      claims: idx.claimsFor('user', userId), orgsById: orgsById(), now,
    });
  }
  function publicProfileForOrg(orgId, now = Date.now()) {
    const org = db.orgs.find((o) => o.id === orgId);
    const profile = toPublicVerificationProfile({
      subjectType: 'org', subjectId: orgId,
      claims: idx.claimsFor('org', orgId), orgsById: orgsById(), now,
    });
    return { ...profile, organisationStatus: orgVerificationStatus(org, db) };
  }

  const shared = {
    ...ctx, idx, verEvent, createClaim, transition, addEvidence, storeEvidenceFile,
    requireVer, vmetric, publicProfileForUser, publicProfileForOrg,
    mintToken: (o) => mintToken(db, nextId, o),
    consumeToken: (o) => consumeToken(db, o),
    effectiveStatus, orgCanAttest: (org) => orgCanAttest(org, db),
    orgVerificationStatus: (org) => orgVerificationStatus(org, db),
    verLevelFor: (orgId, userId) => verLevelFor(db, orgId, userId),
    hasVerLevel: (orgId, userId, lvl) => hasVerLevel(db, orgId, userId, lvl),
    claimProvenanceLabel,
    randomHex: (n = 16) => crypto.randomBytes(n).toString('hex'),
  };

  registerOrganisationVerification(shared);
  registerVerificationReview(shared);

  const tick = () => shared.verificationSweep?.();
  tick();
  const timer = setInterval(tick, process.env.M13_FAST_RETRY === '1' ? 500 : 60_000);
  timer.unref();
  return shared;
}
