// Milestone 14 registration point — Verification & Trust.
// Same architecture as m12/ and m13/: focused modules receive the shared
// server context and register on the EXISTING authenticated routers, so every
// standing gate (bearer sessions, org suspension, guardian ownership,
// visibleToOrg, blocks, moderation) runs before any M14 handler.
//
// Verification proves FACTS; authorization decides ACCESS. Nothing registered
// here loosens visibleToOrg, guardian routing, adult-only representation, the
// grassroots radius, or any other standing rule.
//
// S10a: every record is a row of the verification repository (repositories/verification.mjs), written by explicit
// operations — inside a unit of work wherever a route writes more than one row — and read by SQL queries.
import crypto from 'node:crypto';
import {
  bootstrapVerification, applyTransition, effectiveStatus,
  toPublicVerificationProfile, hasVerLevel, verLevelFor, orgCanAttest,
  orgVerificationStatus, mintToken, consumeToken, peekToken, useToken,
  evidenceFileProblem, claimProvenanceLabel,
} from './shared.mjs';
import { eventDetail, VERIFICATION_LIMITS } from '../../../repositories/verification.mjs';
import { metrics } from '../../../m13/enterprise.mjs';
import { registerOrganisationVerification } from './organisations.mjs';
import { registerVerificationReview } from './review.mjs';

export function registerM14(ctx) {
  const { db, byId, nextId, persist, verification, unit } = ctx;
  const reads = verification.reads;
  bootstrapVerification({ verification, orgs: [...db.orgs] });

  // -------- verification metrics (§61): counters only, never names/emails.
  metrics.verification = {
    requestsCreated: 0, autoPrechecksPassed: 0, routedToHumanReview: 0,
    approvals: 0, rejections: 0, disputes: 0, expiries: 0, revocations: 0,
    emailChallengeFailures: 0,
  };
  const vmetric = (k) => { metrics.verification[k] = (metrics.verification[k] ?? 0) + 1; };
  const cut = (v, max) => (v === null || v === undefined ? null : String(v).slice(0, max));

  // -------- append-only verification event log (§11). The before/after payloads become one detail line.
  function verEvent(type, fields = {}, req = null) {
    return verification.events.append({
      id: nextId('vevt'), ts: Date.now(), type,
      actorKind: fields.actorKind ?? (req?.orgUser ? 'org_user' : 'system'),
      actorId: cut(fields.actorId ?? req?.orgUser?.id ?? null, VERIFICATION_LIMITS.id),
      actorName: cut(fields.actorName ?? req?.orgUser?.name ?? null, VERIFICATION_LIMITS.name),
      actorOrgId: fields.actorOrgId ?? req?.org?.id ?? null,
      requestId: cut(req?.correlationId ?? req?.headers?.['x-request-id'] ?? null, VERIFICATION_LIMITS.requestId),
      // M14.1: how the actor identity was established — 'declared_reviewer'
      // (a named T&S reviewer declared on the request) vs 'shared_admin_key'
      // (the shared prototype admin credential; no individual identity).
      attribution: fields.attribution ?? null,
      claimId: fields.claimId ?? null, subjectId: fields.subjectId ?? null,
      orgId: fields.orgId ?? null, detail: eventDetail(fields.before, fields.after),
      reason: cut(fields.reason ?? null, VERIFICATION_LIMITS.reason),
    });
  }

  // -------- claim construction. THE only creator.
  function createClaim(fields, req = null) {
    const now = Date.now();
    return verification.atomically(() => {
      const claim = verification.claims.create({
        id: nextId('vclm'), subjectType: 'user', organisationId: null, role: null,
        status: 'unverified', validFrom: null, validUntil: null, current: true,
        verificationMethod: null, authorityType: null, authorityId: null,
        evidenceIds: [], createdAt: now, updatedAt: now,
        verifiedAt: null, verifiedBy: null, revokedAt: null, revokedBy: null,
        revocationReason: null, suspendedAt: null, disputedAt: null,
        reviewReasons: [], riskFlags: [], metadata: {},
        ...fields,
      });
      verEvent('claim.created', { claimId: claim.id, subjectId: claim.subjectId, orgId: claim.organisationId, after: { claimType: claim.claimType, status: claim.status } }, req);
      vmetric('requestsCreated');
      return claim;
    });
  }

  const OPEN_OR_VERIFIED = ['unverified', 'collecting_evidence', 'pending', 'automated_checks_passed', 'requires_human_review', 'verified'];
  const AFFILIATION_TYPES = ['CLUB_AFFILIATION', 'CLUB_ROLE', 'AGENCY_AFFILIATION', 'AGENCY_ROLE', 'GRASSROOTS_AFFILIATION'];
  function openClash(id, to) {
    const c = reads.claims.byId(id);
    if (!c || c.subjectType !== 'user' || !OPEN_OR_VERIFIED.includes(to) || OPEN_OR_VERIFIED.includes(c.status)) return null;
    const others = reads.claims.forSubject('user', c.subjectId).filter((x) => x.id !== c.id && x.claimType === c.claimType && OPEN_OR_VERIFIED.includes(x.status));
    if (c.claimType === 'PERSON_IDENTITY' && others.length) return 'IDENTITY_CLAIM_EXISTS';
    if (AFFILIATION_TYPES.includes(c.claimType) && c.current && others.some((x) => x.current && x.organisationId === c.organisationId)) return 'AFFILIATION_CLAIM_EXISTS';
    return null;
  }

  // -------- guarded transition: one call site shape for every status change. `claim` is a claim or its id;
  // `patch(draft)` applies further changes in the same write. Returns null on success or an error code.
  function transition(claim, to, opts, req = null, patch = null) {
    const id = typeof claim === 'string' ? claim : claim.id;
    let err = null; let before = null; let after = null;
    // The one-open-claim rules (one identity claim per user; one current affiliation per user, organisation and type):
    // a claim may not return to an open or verified state while the person has opened another in the meantime.
    const clash = openClash(id, to);
    if (clash) return clash;
    verification.atomically(() => {
      after = verification.claims.update(id, (draft) => {
        before = draft.status;
        err = applyTransition(draft, to, opts);
        if (!err && patch) patch(draft);
      });
      if (err) return;
      verEvent(opts.eventType ?? `claim.${to}`, {
        claimId: id, subjectId: after.subjectId, orgId: after.organisationId,
        actorKind: opts.actorKind, actorId: opts.actorId, actorName: opts.actorName,
        attribution: opts.attribution ?? null,
        before: { status: before }, after: { status: to, method: after.verificationMethod }, reason: opts.reason ?? null,
      }, req);
    });
    if (err) return err;
    if (to === 'verified') vmetric('approvals');
    if (to === 'rejected') vmetric('rejections');
    if (to === 'revoked') vmetric('revocations');
    if (to === 'expired') vmetric('expiries');
    if (to === 'disputed') vmetric('disputes');
    return null;
  }

  // -------- evidence records (§12, §40). Files go through the same storage
  // engine as media but are NEVER exposed on public/static paths — retrieval
  // is a dedicated, authorised route in review.mjs. `claimIds` link the record to those claims at once.
  function addEvidence(fields, req = null) {
    return verification.atomically(() => {
      const ev = verification.evidence.create({
        id: nextId('vevd'), receivedAt: Date.now(), claimIds: [], mediaId: null,
        sha256: null, mime: null, bytes: null, filename: null, meta: {},
        checks: { malwareScan: 'not_configured' }, // no scanner exists — never pretend one ran
        retention: 'until_claim_resolution', visibility: 'trust_and_safety',
        expiresAt: null, ...fields,
      });
      verEvent('evidence.added', { claimId: ev.claimIds[0] ?? null, subjectId: ev.suppliedById, orgId: ev.orgId, after: { type: ev.type, sha256: ev.sha256 } }, req);
      return ev;
    });
  }
  function storeEvidenceFile(dataUrl, filename, req) {
    const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(String(dataUrl ?? ''));
    if (!m) return { error: 'BAD_DATA_URL' };
    const mime = m[1];
    const buf = Buffer.from(m[2], 'base64');
    const problem = evidenceFileProblem({ mime, bytes: buf.length, filename: filename ?? 'evidence', buffer: buf });
    if (problem) return { error: problem };
    const id = nextId('vfil');
    // sanitized server name = our own id; the original name is metadata only
    ctx.storage.saveDataUrl(id, `data:${mime};base64,${buf.toString('base64')}`);
    return {
      // M23 P7 (D-P7-1): the digest is of the exact BYTES. `sha256(String(buf))`
      // hashed a UTF-8 decoding of the file, so two different binaries could
      // share a digest and a signing document's digest did not name its bytes.
      mediaId: id, sha256: crypto.createHash('sha256').update(buf).digest('hex'), mime, bytes: buf.length, filename: String(filename ?? '').slice(0, VERIFICATION_LIMITS.filename),
      // contentSignature is format identification (magic bytes), NOT malware
      // scanning — malwareScan stays not_configured and is never conflated.
      checks: { malwareScan: 'not_configured', contentSignature: 'matched_claimed_type' },
    };
  }

  // -------- verification-permission guard (§9). Server-enforced; a disabled
  // button is never the control. Root-level operations additionally require
  // an MFA-enabled account (existing F12 infrastructure).
  function requireVer(req, res, atLeast, { root = false } = {}) {
    if (!hasVerLevel(reads, req.org.id, req.orgUser.id, atLeast)) {
      res.status(403).json({ error: 'VERIFICATION_PERMISSION_REQUIRED', message: `This needs ${atLeast.replace(/_/g, ' ')} authority for your organisation.` });
      return false;
    }
    if (root && !req.orgUser.mfa?.enabledAt) {
      res.status(403).json({ error: 'MFA_REQUIRED_FOR_ROOT_OPERATION', message: 'Sensitive verification-authority operations require an account with MFA enabled (Organisation → Security).' });
      return false;
    }
    return true;
  }

  /** The organisations a list of claims names, by id (one lookup each, through the index). */
  const orgsFor = (claims) => new Map([...new Set(claims.map((c) => c.organisationId).filter(Boolean))].map((id) => [id, byId.org(id)]).filter(([, o]) => o));

  function publicProfileForUser(userId, now = Date.now()) {
    // Removed/deactivated accounts lose CURRENT public verification at once:
    // the removed state feeds the read-time engine on every projection — no
    // cached boolean can bypass it. Closed historical periods stay visible
    // as history per §15 (truth is not erased).
    const user = byId.user(userId);
    const claims = reads.claims.forSubject('user', userId);
    return toPublicVerificationProfile({
      subjectType: 'user', subjectId: userId, claims, orgsById: orgsFor(claims),
      subjectRemoved: !user || !!user.removedAt, now,
    });
  }
  function publicProfileForOrg(orgId, now = Date.now()) {
    const org = byId.org(orgId);
    const claims = reads.claims.forSubject('org', orgId);
    const profile = toPublicVerificationProfile({ subjectType: 'org', subjectId: orgId, claims, orgsById: orgsFor(claims), now });
    return { ...profile, organisationStatus: orgVerificationStatus(org, reads) };
  }

  const shared = {
    ...ctx, reads, verEvent, createClaim, transition, addEvidence, storeEvidenceFile,
    requireVer, vmetric, publicProfileForUser, publicProfileForOrg, unit: unit ?? ((fn) => verification.atomically(fn)),
    mintToken: (o) => mintToken(verification.tokens, nextId, o),
    consumeToken: (o) => consumeToken(verification.tokens, o),
    peekToken: (o) => peekToken(verification.tokens, o),
    useToken: (t) => useToken(verification.tokens, t),
    effectiveStatus, orgCanAttest: (org) => orgCanAttest(org, reads),
    orgVerificationStatus: (org) => orgVerificationStatus(org, reads),
    verLevelFor: (orgId, userId) => verLevelFor(reads, orgId, userId),
    hasVerLevel: (orgId, userId, lvl) => hasVerLevel(reads, orgId, userId, lvl),
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
