// Organisation verification: personal claims, work-email proof, the club Verification console, official domains,
// the verification-admin hierarchy (with dual control), squad invitations, conflict declarations and coach references.
//
// Authority model: a person can never verify themselves. Employment and
// role facts are confirmed by an AUTHORISED ORGANISATION ADMINISTRATOR of a
// VERIFIED organisation; domain control is evidence of mailbox control, never
// of employment. Where no authority exists, the case routes to Trust & Safety
// as a prepared human-review case — humans are the LAST step, not the first.
import { isAdult, visibleToOrg } from '../../../domain.mjs';
import { parseDateOrInstant, isAbsent } from '../../../temporal.mjs';
import {
  emailProblem, domainOfEmail, isFreeMail, isDisposable, normalizeDomain,
  domainCovered, riskFlags, decideReview, evidenceCompleteness, verLevelRank,
  VER_LEVELS, sha256,
} from './shared.mjs';
import { VERIFICATION_LIMITS as L, CONFLICT_KINDS } from '../../../repositories/verification.mjs';

const AFFILIATION_TYPE = (org) =>
  org.type === 'agency' ? ['AGENCY_AFFILIATION', 'AGENCY_ROLE']
    : org.level === 'grassroots' ? ['GRASSROOTS_AFFILIATION', 'CLUB_ROLE']
      : ['CLUB_AFFILIATION', 'CLUB_ROLE'];

export function registerOrganisationVerification(ctx) {
  const {
    byId, app, orgRouter, playerRouter, guardianRouter, nextId,
    notify, mailer, verification, reads, unit, verEvent, createClaim, transition, addEvidence,
    storeEvidenceFile, requireVer, vmetric, publicProfileForUser, publicProfileForOrg,
    mintToken, effectiveStatus, orgCanAttest, verLevelFor,
    hasVerLevel, findPlayer, isBlocked, randomHex,
  } = ctx;

  const openStates = ['unverified', 'collecting_evidence', 'pending', 'automated_checks_passed', 'requires_human_review'];
  const userClaims = (userId) => reads.claims.forSubject('user', userId);
  const orgOf = (id) => byId.org(id) ?? null;
  const verifiedDomainsOf = (orgId) => reads.domains.forOrg(orgId).filter((d) => d.status === 'verified').map((d) => d.domain);
  const reviewersOf = (orgId, atLeast = 'verification_reviewer') =>
    reads.admins.activeForOrg(orgId).filter((a) => verLevelRank(a.level) >= verLevelRank(atLeast))
      .map((a) => byId.user(a.userId, (u) => !u.removedAt)).filter(Boolean);
  const notifyReviewers = (orgId, text, refId) => {
    for (const u of reviewersOf(orgId)) notify({ kind: 'org_user', id: u.id }, 'verification', text, refId);
  };
  const emailFailsFor = (userId) => reads.tokens.failedAttempts(userId, 'work_email');
  const onlyOrg = (req, r) => (r && r.orgId === req.org.id ? r : null);
  const fieldInvalid = (res, field, message) => res.status(400).json({ error: 'FIELD_INVALID', field, message });

  // Subject's own view of a claim: status + reasons + own evidence summaries.
  // Never someone else's evidence, never reviewer notes.
  const subjectClaimView = (claim) => {
    const org = claim.organisationId ? orgOf(claim.organisationId) : null;
    const eff = effectiveStatus(claim, { org });
    return {
      id: claim.id, claimType: claim.claimType, status: claim.status,
      effective: { status: eff.status, current: eff.current, historical: eff.historical },
      organisation: org ? { id: org.id, name: org.name } : null,
      role: claim.role, validFrom: claim.validFrom, validUntil: claim.validUntil,
      current: claim.current, verificationMethod: claim.verificationMethod,
      verifiedAt: claim.verifiedAt, provenance: claim.status === 'verified' ? ctx.claimProvenanceLabel(claim, org?.name) : null,
      reviewReasons: claim.reviewReasons, createdAt: claim.createdAt, updatedAt: claim.updatedAt,
      revocationReason: claim.revocationReason, disputedAt: claim.disputedAt,
      evidence: reads.evidence.byIds(claim.evidenceIds).map((e) => ({
        id: e.id, type: e.type, receivedAt: e.receivedAt, filename: e.filename,
        checks: e.checks, note: e.meta?.note ?? null,
      })),
      humanReviewNote: claim.status === 'requires_human_review'
        ? humanReviewExplanation(claim) : null,
    };
  };
  function humanReviewExplanation(claim) {
    // The UI must explain WHY, in plain language, without leaking
    // internal security rules.
    const bits = [];
    if (claim.reviewReasons.includes('ROOT_ORGANISATION_BOOTSTRAP')) bits.push('an authorised organisation administrator has not yet been established for this organisation');
    if (claim.reviewReasons.includes('NO_AUTHORITATIVE_SOURCE')) bits.push('no authorised administrator or authoritative registry can confirm this automatically');
    if (claim.reviewReasons.includes('DOCUMENT_AUTHENTICITY_UNCONFIRMED')) bits.push('an uploaded document is evidence, not proof — a reviewer checks it against authoritative sources');
    if (claim.reviewReasons.includes('DISPUTED_CLAIM')) bits.push('the claim is under dispute');
    return `ScoutBox needs to review this request${bits.length ? ` because ${bits.join('; ')}` : ''}.`;
  }

  // ============================================ personal verification
  orgRouter.get('/verification/me', (req, res) => {
    const claims = userClaims(req.orgUser.id).map(subjectClaimView);
    const [affType] = AFFILIATION_TYPE(req.org);
    const idClaim = claims.find((c) => c.claimType === 'PERSON_IDENTITY');
    const affClaim = claims.find((c) => c.claimType === affType && c.organisation?.id === req.org.id && c.current !== false);
    const emailProved = claims.some((c) => c.evidence.some((e) => e.type === 'official_email'));
    res.json({
      claims,
      verificationLevel: verLevelFor(req.org.id, req.orgUser.id),
      organisationStatus: ctx.orgVerificationStatus(req.org),
      steps: [ // progress persists because it derives from records
        { id: 'identity', label: 'Verify identity', done: idClaim?.status === 'verified', state: idClaim?.status ?? 'not_started' },
        { id: 'organisation', label: 'Select organisation', done: true, state: 'done' },
        { id: 'role', label: 'Add professional role', done: !!affClaim, state: affClaim ? 'done' : 'not_started' },
        { id: 'work_email', label: 'Verify work email', done: emailProved, state: emailProved ? 'done' : 'not_started' },
        { id: 'confirmation', label: 'Organisation confirmation', done: affClaim?.status === 'verified', state: affClaim?.status ?? 'not_started' },
      ],
      publicPreview: publicProfileForUser(req.orgUser.id),
    });
  });

  orgRouter.post('/verification/identity', (req, res) => {
    if (reads.claims.hasOpenIdentity(req.orgUser.id)) {
      return res.status(409).json({ error: 'IDENTITY_CLAIM_EXISTS', message: 'An identity verification is already open or complete.' });
    }
    const claim = createClaim({
      subjectType: 'user', subjectId: req.orgUser.id, claimType: 'PERSON_IDENTITY',
      status: 'collecting_evidence', metadata: { declaredName: (req.orgUser.name == null ? null : String(req.orgUser.name).slice(0, L.name)) },
    }, req);
    res.status(201).json({ claim: subjectClaimView(claim), note: 'Add an identity document as evidence, then submit. A document is evidence — verification happens in review, never on upload.' });
  });

  orgRouter.post('/verification/claims/:id/evidence', (req, res) => {
    const claim = reads.claims.byId(req.params.id);
    if (!claim || claim.subjectId !== req.orgUser.id || claim.subjectType !== 'user') {
      return res.status(404).json({ error: 'CLAIM_NOT_FOUND' }); // concealment: no cross-tenant existence leak
    }
    if (!['unverified', 'collecting_evidence', 'pending'].includes(claim.status)) {
      return res.status(409).json({ error: 'CLAIM_NOT_EDITABLE', message: 'Evidence can only be added before review completes.' });
    }
    const { dataUrl, filename, note } = req.body ?? {};
    if (!(note === undefined || note === null || typeof note === 'string')) return fieldInvalid(res, 'note', 'note is text.');
    if (!(filename === undefined || filename === null || typeof filename === 'string')) return fieldInvalid(res, 'filename', 'filename is text.');
    let fileFields = {};
    if (dataUrl) {
      const stored = storeEvidenceFile(dataUrl, filename, req);
      if (stored.error) return res.status(422).json({ error: stored.error });
      fileFields = stored;
    } else if (!note?.trim()) {
      return res.status(400).json({ error: 'EVIDENCE_REQUIRED', message: 'Attach a document or a note.' });
    }
    // Duplicate-evidence hash detection (risk signal, not a verdict).
    const dup = fileFields.sha256 && reads.evidence.digestSeen(fileFields.sha256, req.orgUser.id);
    const ev = unit(() => {
      const added = addEvidence({
        type: 'document', source: 'subject_upload', suppliedByKind: 'org_user', suppliedById: req.orgUser.id,
        orgId: req.org.id, claimIds: [claim.id], ...fileFields, meta: { note: String(note ?? '').slice(0, L.note) },
        visibility: ['PERSON_IDENTITY', 'LICENCE'].includes(claim.claimType) ? 'trust_and_safety' : 'organisation_internal',
      }, req);
      if (dup) verification.claims.addRiskFlags(claim.id, { codes: ['DUPLICATE_EVIDENCE_HASH'] });
      if (claim.status === 'unverified') applyStatus(claim, 'collecting_evidence', req);
      return added;
    });
    res.status(201).json({ claim: subjectClaimView(reads.claims.byId(claim.id)), evidenceChecks: ev.checks });
  });
  function applyStatus(claim, to, req, opts = {}, also = {}) {
    return transition(claim, to, { actorKind: req.orgUser ? 'org_user' : 'system', actorId: req.orgUser?.id, actorName: req.orgUser?.name, ...opts }, req, also);
  }
  /** The claim when it is the caller's own (a user subject), or null: concealment, no cross-tenant existence leak. */
  const onlyMine = (req, c) => (c && c.subjectId === req.orgUser.id && c.subjectType === 'user' ? c : null);

  // Submit → deterministic pre-review pipeline: completeness, dedupe,
  // conflicts, risk flags, decision, routing, packaged case. All automated —
  // the only humans afterwards are the AUTHORITATIVE ones.
  orgRouter.post('/verification/claims/:id/submit', (req, res) => {
    const claim = onlyMine(req, reads.claims.byId(req.params.id));
    if (!claim) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    if (!['collecting_evidence', 'unverified'].includes(claim.status)) {
      return res.status(409).json({ error: 'ALREADY_SUBMITTED' });
    }
    const evTypes = reads.evidence.byIds(claim.evidenceIds).map((e) => e.type);
    const completeness = evidenceCompleteness(claim.claimType, evTypes);
    if (!completeness.complete) {
      return res.status(422).json({ error: 'EVIDENCE_INCOMPLETE', missing: completeness.missing });
    }
    unit(() => {
      if (claim.status === 'unverified') applyStatus(claim, 'collecting_evidence', req);
      applyStatus(claim, 'pending', req);
      routeClaim(claim.id, req);
    });
    res.json({ claim: subjectClaimView(reads.claims.byId(claim.id)) });
  });

  /** Inside the caller's unit: the deterministic pre-review pipeline for claim `claimId` (just moved to pending). */
  function routeClaim(claimId, req) {
    const claim = reads.claims.byId(claimId);
    const org = claim.organisationId ? orgOf(claim.organisationId) : null;
    const flags = riskFlags({
      email: claim.metadata?.workEmail,
      orgDomains: org ? verifiedDomainsOf(org.id) : [],
      applicantHadRecentRevocation: userClaims(claim.subjectId).some((c) => c.status === 'revoked' && c.revokedAt > Date.now() - 30 * 86_400_000),
      competingOrgClaims: userClaims(claim.subjectId).filter((c) => c.id !== claim.id && c.claimType === claim.claimType && c.organisationId && c.organisationId !== claim.organisationId && openStates.includes(c.status)).length,
      orgSuspended: !!org?.suspended,
      emailChallengeFails: emailFailsFor(claim.subjectId),
      duplicateEvidenceHash: claim.riskFlags.includes('DUPLICATE_EVIDENCE_HASH'),
    });
    const documentOnly = reads.evidence.byIds(claim.evidenceIds).every((e) => e.type === 'document');
    const { decision, reasons } = decideReview({
      claimType: claim.claimType,
      orgHasActiveAuthority: !!org && orgCanAttest(org) && reviewersOf(org.id).length > 0,
      documentOnly, riskFlagCount: flags.length,
      disputed: !!claim.disputedAt,
    });
    const record = { addRiskFlags: flags, reviewReasons: reasons };
    if (decision === 'REQUIRES_HUMAN_REVIEW') {
      applyStatus(claim, 'requires_human_review', req, {}, record);
      vmetric('routedToHumanReview');
    } else {
      applyStatus(claim, 'automated_checks_passed', req, {}, record);
      vmetric('autoPrechecksPassed');
      verEvent('automated_check.passed', { claimId: claim.id, subjectId: claim.subjectId, orgId: claim.organisationId, after: { riskFlags: flags } }, req);
      if (claim.organisationId) {
        notifyReviewers(claim.organisationId, `${req.orgUser?.name ?? 'A colleague'} asks ${org?.name} to confirm ${claim.claimType === 'CLUB_ROLE' || claim.claimType === 'AGENCY_ROLE' ? `the role “${claim.role}”` : 'their affiliation'}.`, claim.id);
      }
    }
  }

  // ----- professional affiliation request (creates the linked pair)
  orgRouter.post('/verification/affiliation', (req, res) => {
    if (!(req.body?.role === undefined || req.body?.role === null || typeof req.body.role === 'string')) return fieldInvalid(res, 'role', 'role is text.');
    const role = String(req.body?.role ?? req.orgUser.role ?? '').trim().slice(0, L.role);
    if (!role) return res.status(400).json({ error: 'ROLE_REQUIRED' });
    const startP = isAbsent(req.body?.validFrom) ? null : parseDateOrInstant(req.body.validFrom, { dayEdge: 'start' });
    if (startP && !startP.ok) return res.status(400).json({ error: 'DATE_INVALID', field: 'validFrom', message: `validFrom is a calendar day (YYYY-MM-DD) or an instant (${startP.why}).`, expected: startP.expected });
    const [affType, roleType] = AFFILIATION_TYPE(req.org);
    const existing = userClaims(req.orgUser.id).filter((c) => c.organisationId === req.org.id && [affType, roleType].includes(c.claimType) && c.current !== false && [...openStates, 'verified'].includes(c.status));
    if (existing.length) return res.status(409).json({ error: 'AFFILIATION_CLAIM_EXISTS', message: 'A current affiliation request or verification already exists for this organisation.' });
    const pairId = nextId('vpair');
    const base = {
      subjectType: 'user', subjectId: req.orgUser.id, organisationId: req.org.id,
      status: 'collecting_evidence', metadata: { pairId, declaredName: (req.orgUser.name == null ? null : String(req.orgUser.name).slice(0, L.name)), requestedStart: startP ? startP.ms : null },
    };
    const [aff, roleClaim] = unit(() => [createClaim({ ...base, claimType: affType }, req), createClaim({ ...base, claimType: roleType, role }, req)]);
    res.status(201).json({
      affiliation: subjectClaimView(aff), role: subjectClaimView(roleClaim),
      next: 'Prove control of your work email (POST /org/verification/work-email), then the organisation confirms the relationship. Email control alone never equals verified employment.',
    });
  });

  // ----- work-email proof. One-time token; failure counting; the code
  // travels ONLY in the email (local fake transport in this environment).
  orgRouter.post('/verification/work-email', async (req, res) => {
    if (typeof req.body?.email !== 'string') return res.status(400).json({ error: 'EMAIL_SYNTAX' });
    const email = req.body.email.trim().toLowerCase();
    const problem = emailProblem(email);
    if (problem) return res.status(400).json({ error: problem });
    const dom = domainOfEmail(email);
    if (isDisposable(dom)) return res.status(422).json({ error: 'DISPOSABLE_EMAIL_REFUSED', message: 'Disposable addresses cannot prove a working relationship.' });
    if (isFreeMail(dom)) return res.status(422).json({ error: 'COMPANY_EMAIL_REQUIRED', message: 'A free-provider address does not evidence organisation email control. If your organisation has no domain, ask the organisation to confirm you directly — or Trust & Safety reviews the case.' });
    const secret = mintToken({ purpose: 'work_email', email, subjectKind: 'org_user', subjectId: req.orgUser.id, orgId: req.org.id });
    await mailer.send({
      to: email,
      subject: 'Confirm your work email for ScoutBox verification',
      text: `Hi ${req.orgUser.name},\n\nYour ScoutBox work-email confirmation code is ${secret}\n\nEntering it proves control of this mailbox. It expires in 30 minutes and works once.\n\nIf you did not request this, ignore the email.`,
    });
    verEvent('email.challenge_sent', { subjectId: req.orgUser.id, orgId: req.org.id, after: { domain: dom } }, req);
    res.status(201).json({ sent: true, note: 'Enter the code from the mailbox. Codes are single-use and expire in 30 minutes.' });
  });

  orgRouter.post('/verification/work-email/confirm', (req, res) => {
    const { code, email } = req.body ?? {};
    if (!(email === undefined || email === null || typeof email === 'string')) return res.status(400).json({ error: 'EMAIL_SYNTAX' });
    if (!(code === undefined || code === null || typeof code === 'string')) return fieldInvalid(res, 'code', 'code is text.');
    // Validate first: the token is consumed only together with the evidence and the claims it proves (one unit).
    const peek = ctx.peekToken({ purpose: 'work_email', secret: code, email: email ?? null, subjectId: req.orgUser.id });
    if (peek.error) {
      // count failures against open tokens for this user (risk signal)
      verification.tokens.recordFailedAttempts(req.orgUser.id, 'work_email');
      vmetric('emailChallengeFailures');
      return res.status(peek.error === 'TOKEN_EXPIRED' ? 410 : 401).json({ error: peek.error });
    }
    if (peek.token.subjectId !== req.orgUser.id) return res.status(403).json({ error: 'TOKEN_WRONG_ACCOUNT' });
    const dom = domainOfEmail(peek.token.email);
    const covered = verifiedDomainsOf(req.org.id).some((d) => domainCovered(dom, d));
    const [affType, roleType] = AFFILIATION_TYPE(req.org);
    const open = userClaims(req.orgUser.id).filter((c) => c.organisationId === req.org.id && [affType, roleType].includes(c.claimType) && openStates.includes(c.status));
    if (!open.length) {
      ctx.useToken(peek.token); // a correct code is spent even when there is nothing to attach it to
      return res.status(409).json({ error: 'NO_OPEN_AFFILIATION', message: 'Request an affiliation first — the email proof attaches to it.' });
    }
    unit(() => {
      ctx.useToken(peek.token);
      addEvidence({
        type: 'official_email', source: 'email_challenge', suppliedByKind: 'org_user', suppliedById: req.orgUser.id,
        orgId: req.org.id, claimIds: open.map((c) => c.id), visibility: 'organisation_internal',
        meta: { domain: dom, domainCoveredByOrg: covered, addressHash: sha256(peek.token.email) }, // the address itself is not stored on the evidence record
      }, req);
      for (const c of open) {
        verification.claims.recordWorkEmail(c.id, { workEmail: peek.token.email, domainCoveredByOrg: covered }); // subject+org internal, never public
        verEvent('email.challenge_passed', { claimId: c.id, subjectId: req.orgUser.id, orgId: req.org.id, after: { domain: dom, covered } }, req);
        if (['collecting_evidence', 'unverified'].includes(c.status)) {
          if (c.status === 'unverified') applyStatus(c, 'collecting_evidence', req);
          applyStatus(c, 'pending', req);
          routeClaim(c.id, req);
        }
      }
    });
    res.json({
      domainControl: 'passed', domainCoveredByOrg: covered,
      claims: open.map((c) => subjectClaimView(reads.claims.byId(c.id))),
      note: 'Email control recorded as evidence. It does NOT by itself verify employment — an authorised organisation administrator confirms the relationship next.',
    });
  });

  // ----- disputes from the subject
  orgRouter.post('/verification/claims/:id/dispute', (req, res) => {
    const claim = onlyMine(req, reads.claims.byId(req.params.id));
    if (!claim) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    if (!(req.body?.reason === undefined || req.body?.reason === null || typeof req.body.reason === 'string')) return fieldInvalid(res, 'reason', 'reason is text.');
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'REASON_REQUIRED' });
    return openDispute(res, claim, { byKind: 'org_user', byId: req.orgUser.id, byName: req.orgUser.name }, reason, req);
  });
  function openDispute(res, claim, by, reason, req) {
    if (reads.disputes.hasOpen(claim.id)) {
      return res.status(409).json({ error: 'DISPUTE_ALREADY_OPEN' });
    }
    const d = unit(() => {
      const created = verification.disputes.create({
        id: nextId('vdsp'), claimId: claim.id, byKind: by.byKind, byId: by.byId, byName: by.byName == null ? null : String(by.byName).slice(0, L.name), reason: reason.slice(0, L.reason),
        status: 'open', resolution: null, createdAt: Date.now(), resolvedAt: null, resolvedBy: null, resolvedById: null, resolutionAttribution: null,
      });
      if (claim.status === 'verified') applyStatus(claim, 'disputed', req ?? { orgUser: null }, { reason });
      else verification.claims.addReviewReasons(claim.id, { codes: ['DISPUTED_CLAIM'] });
      verEvent('claim.disputed', { claimId: claim.id, subjectId: claim.subjectId, orgId: claim.organisationId, reason, actorKind: by.byKind, actorId: by.byId, actorName: by.byName });
      return created;
    });
    vmetric('disputes');
    res.status(201).json({ dispute: d, note: 'The claim is flagged, its history is preserved, and Trust & Safety reviews the dispute. Disputed claims never silently disappear.' });
    return null;
  }
  ctx.openDispute = openDispute;

  // ============================================== safe public projections
  orgRouter.get('/verification/public/user/:id', (req, res) => res.json(publicProfileForUser(req.params.id)));
  orgRouter.get('/verification/public/org/:id', (req, res) => res.json(publicProfileForOrg(req.params.id)));
  // Batch endpoint so list screens do ONE call, not N.
  orgRouter.get('/verification/public/users', (req, res) => {
    const ids = String(req.query.ids ?? '').split(',').filter(Boolean).slice(0, 100);
    res.json({ profiles: ids.map((id) => publicProfileForUser(id)) });
  });
  playerRouter.get('/verification/org/:id', (req, res) => res.json(publicProfileForOrg(req.params.id)));
  guardianRouter.get('/verification/org/:id', (req, res) => res.json(publicProfileForOrg(req.params.id)));

  // ================================================== console: dashboard
  orgRouter.get('/verification/dashboard', (req, res) => {
    if (!requireVer(req, res, 'verification_viewer')) return;
    const mine = reads.claims.forOrgStaff(req.org.id);
    const now = Date.now();
    // "Currently verified" derives from the EFFECTIVE engine: a raw
    // status of 'verified' does not count when org standing, account removal
    // or expiry suppresses it at read time.
    const effCurrent = (c) => {
      const u = byId.user(c.subjectId);
      return effectiveStatus(c, { org: req.org, subjectRemoved: !u || !!u.removedAt, now }).current;
    };
    res.json({
      organisationStatus: ctx.orgVerificationStatus(req.org),
      counts: {
        verifiedStaff: new Set(mine.filter(effCurrent).map((c) => c.subjectId)).size,
        pending: mine.filter((c) => ['pending', 'automated_checks_passed'].includes(c.status)).length,
        humanReview: mine.filter((c) => c.status === 'requires_human_review').length,
        expiringSoon: mine.filter((c) => c.status === 'verified' && c.validUntil && c.validUntil > now && c.validUntil < now + 30 * 86_400_000).length,
        disputed: reads.disputes.openCountForOrg(req.org.id),
        revoked: mine.filter((c) => c.status === 'revoked').length,
        domains: reads.domains.forOrg(req.org.id).length,
        administrators: reads.admins.activeForOrg(req.org.id).length,
      },
    });
  });

  // Prepared request rows: identity state, email/domain status, risk
  // flags and history — the admin decides on a PACKAGED case.
  const requestRow = (claim) => {
    const user = byId.user(claim.subjectId);
    const identity = userClaims(claim.subjectId).find((c) => c.claimType === 'PERSON_IDENTITY');
    return {
      claimId: claim.id, claimType: claim.claimType, pairId: claim.metadata?.pairId ?? null,
      person: { id: user?.id, name: user?.name, email: user?.email ?? null, accountCreatedAt: user?.createdAt ?? null, removed: !!user?.removedAt },
      claimedRole: claim.role, requestedStart: claim.metadata?.requestedStart ?? null,
      identityStatus: identity?.status ?? 'unverified',
      emailStatus: claim.metadata?.domainControl === 'passed'
        ? (claim.metadata?.domainCoveredByOrg ? 'work_email_on_verified_domain' : 'work_email_on_other_domain')
        : 'not_proved',
      riskFlags: claim.riskFlags, status: claim.status, requestedAt: claim.createdAt,
      priorClaims: userClaims(claim.subjectId).filter((c) => c.id !== claim.id && c.status === 'verified').map((c) => ({ claimType: c.claimType, organisationId: c.organisationId, role: c.role, current: c.current })),
    };
  };

  orgRouter.get('/verification/requests', (req, res) => {
    if (!requireVer(req, res, 'verification_viewer')) return;
    const rows = reads.claims.forOrgStaff(req.org.id)
      .filter((c) => ['pending', 'automated_checks_passed'].includes(c.status))
      .map(requestRow);
    res.json({ items: rows, note: 'Decisions are audited. You cannot decide your own request.' });
  });

  // The confirmation decision: confirm / correct role / correct dates /
  // mark former / reject / request more information.
  orgRouter.post('/verification/requests/:claimId/decide', (req, res) => {
    if (!requireVer(req, res, 'verification_reviewer')) return;
    const found = reads.claims.byId(req.params.claimId);
    const claim = found && found.organisationId === req.org.id && found.subjectType === 'user' ? found : null;
    if (!claim) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    // Self-verification prohibition — server-side, always, with an event.
    if (claim.subjectId === req.orgUser.id) {
      verEvent('security.self_verification_blocked', { claimId: claim.id, subjectId: claim.subjectId, orgId: req.org.id, reason: 'reviewer attempted to decide own claim' }, req);
      return res.status(403).json({ error: 'SELF_VERIFICATION_FORBIDDEN', message: 'You cannot be the authoritative confirmer of your own claim. Another authorised administrator must decide it.' });
    }
    if (!['pending', 'automated_checks_passed'].includes(claim.status)) {
      return res.status(409).json({ error: 'CLAIM_NOT_DECIDABLE', message: `The request is ${claim.status} — it may already be decided, withdrawn or escalated.` });
    }
    // A suspended / unverified / revoked organisation cannot attest.
    if (!orgCanAttest(req.org)) {
      return res.status(403).json({ error: 'ORG_NOT_ELIGIBLE', message: `This organisation is ${ctx.orgVerificationStatus(req.org)} and cannot confirm staff verification right now.` });
    }
    const { action, role, validFrom, validUntil, reason } = req.body ?? {};
    if (!(reason === undefined || reason === null || typeof reason === 'string')) return fieldInvalid(res, 'reason', 'reason is text.');
    if (!(role === undefined || role === null || typeof role === 'string')) return fieldInvalid(res, 'role', 'role is text.');
    const pair = claim.metadata?.pairId ? reads.claims.byPair(claim.metadata.pairId).filter((c) => ['pending', 'automated_checks_passed'].includes(c.status)) : [];
    const targets = pair.length ? pair : [claim];
    /** One unit: every target moves (or none does). A refused transition throws inside the unit and is answered 409. */
    const decide = (to, extra = {}, before = null) => {
      try {
        unit(() => {
          before?.();
          for (const c of targets) {
            const err = applyStatus(c, to, req, { method: 'organisation_admin_confirmation', reason, eventType: to === 'verified' ? 'review.approved' : 'review.rejected' }, {
              set: { ...extra, ...(to === 'verified' ? { authorityType: 'org_admin', authorityId: req.orgUser.id } : {}) },
            });
            if (err) throw Object.assign(new Error(err), { decideError: err });
          }
        });
      } catch (e) { if (e.decideError) return e.decideError; throw e; }
      return null;
    };
    if (action === 'confirm' || action === 'correct_role' || action === 'mark_former') {
      const roleClaim = targets.find((c) => /ROLE/.test(c.claimType));
      let correct = null;
      let roleNow = roleClaim?.role ?? null;
      if (action === 'correct_role') {
        if (!role?.trim()) return res.status(400).json({ error: 'ROLE_REQUIRED' });
        if (roleClaim) {
          roleNow = String(role).trim().slice(0, L.role);
          correct = () => {
            verEvent('claim.corrected', { claimId: roleClaim.id, subjectId: claim.subjectId, orgId: req.org.id, before: { role: roleClaim.role }, after: { role: String(role).trim() } }, req);
            verification.claims.correctRole(roleClaim.id, { role: roleNow });
          };
        }
      }
      const fromP = isAbsent(validFrom) ? null : parseDateOrInstant(validFrom, { dayEdge: 'start' });
      if (fromP && !fromP.ok) return res.status(400).json({ error: 'DATE_INVALID', field: 'validFrom', message: `validFrom is a calendar day (YYYY-MM-DD) or an instant (${fromP.why}).`, expected: fromP.expected });
      const untilP = isAbsent(validUntil) ? null : parseDateOrInstant(validUntil, { dayEdge: 'end' });
      if (untilP && !untilP.ok) return res.status(400).json({ error: 'DATE_INVALID', field: 'validUntil', message: `validUntil is a calendar day (YYYY-MM-DD) or an instant (${untilP.why}).`, expected: untilP.expected });
      const from = fromP ? fromP.ms : Date.now();
      const until = untilP ? untilP.ms : (action === 'mark_former' ? Date.now() : null);
      // Ordering is checked only when the club STATED both ends; a defaulted start is "now" by convention, not a claim.
      if (fromP && untilP && !(from < until)) return res.status(400).json({ error: 'INTERVAL_INVALID', field: 'validUntil', message: 'The period must end after it starts.' });
      const err = decide('verified', { validFrom: from, validUntil: until, current: action !== 'mark_former' }, correct);
      if (err) return res.status(409).json({ error: err });
      notify({ kind: 'org_user', id: claim.subjectId }, 'verification', `${req.org.name} confirmed your ${action === 'mark_former' ? 'historical ' : ''}affiliation${roleClaim ? ` as ${roleNow}` : ''}. ✓`, claim.id);
    } else if (action === 'reject') {
      if (!reason?.trim()) return res.status(400).json({ error: 'REASON_REQUIRED', message: 'A rejection needs a reason — it is shown to the person and audited.' });
      const err = decide('rejected');
      if (err) return res.status(409).json({ error: err });
      notify({ kind: 'org_user', id: claim.subjectId }, 'verification', `${req.org.name} declined the verification request: ${String(reason).slice(0, 140)}`, claim.id);
    } else if (action === 'request_info') {
      unit(() => { for (const c of targets) applyStatus(c, 'collecting_evidence', req, { reason }); });
      notify({ kind: 'org_user', id: claim.subjectId }, 'verification', `${req.org.name} asks for more information on your verification request${reason ? `: ${String(reason).slice(0, 140)}` : ''}.`, claim.id);
    } else {
      return res.status(400).json({ error: 'ACTION_UNKNOWN', message: 'Use confirm, correct_role, mark_former, reject or request_info.' });
    }
    ctx.ledgerAppend?.({ type: 'verification_decision', orgId: req.org.id, scoutName: req.orgUser.name, playerId: null, detail: { claimId: claim.id, action } });
    res.json({ decided: action, claims: targets.map((c) => subjectClaimView(reads.claims.byId(c.id))) });
  });

  // ----- staff registry with filters
  orgRouter.get('/verification/staff', (req, res) => {
    if (!requireVer(req, res, 'verification_viewer')) return;
    const { state, current, method, role } = req.query;
    let rows = reads.claims.forOrgStaff(req.org.id).filter((c) => !['unverified'].includes(c.status));
    if (state) rows = rows.filter((c) => c.status === state);
    if (current === 'true') rows = rows.filter((c) => c.current !== false);
    if (current === 'false') rows = rows.filter((c) => c.current === false);
    if (method) rows = rows.filter((c) => c.verificationMethod === method);
    if (role) rows = rows.filter((c) => (c.role ?? '').toLowerCase().includes(String(role).toLowerCase()));
    res.json({
      items: rows.map((c) => {
        const u = byId.user(c.subjectId);
        const eff = effectiveStatus(c, { org: req.org });
        return {
          claimId: c.id, person: { id: u?.id, name: u?.name }, claimType: c.claimType, role: c.role,
          status: c.status, effective: eff, current: c.current, validFrom: c.validFrom, validUntil: c.validUntil,
          verificationMethod: c.verificationMethod, verifiedAt: c.verifiedAt,
        };
      }),
    });
  });

  // ----- employment change: close the period, keep the truth.
  orgRouter.post('/verification/staff/:userId/departed', (req, res) => {
    if (!requireVer(req, res, 'verification_reviewer')) return;
    if (req.params.userId === req.orgUser.id) return res.status(403).json({ error: 'SELF_VERIFICATION_FORBIDDEN', message: 'Ask another administrator to record your own departure.' });
    const claims = reads.claims.forOrgSubject(req.org.id, req.params.userId).filter((c) => c.status === 'verified' && c.current !== false);
    if (!claims.length) return res.status(404).json({ error: 'NO_CURRENT_VERIFIED_CLAIMS' });
    const untilP = isAbsent(req.body?.validUntil) ? null : parseDateOrInstant(req.body.validUntil, { dayEdge: 'end' });
    if (untilP && !untilP.ok) return res.status(400).json({ error: 'DATE_INVALID', field: 'validUntil', message: `validUntil is a calendar day (YYYY-MM-DD) or an instant (${untilP.why}).`, expected: untilP.expected });
    const until = untilP ? untilP.ms : Date.now();
    unit(() => {
      for (const c of claims) {
        verEvent('claim.corrected', { claimId: c.id, subjectId: c.subjectId, orgId: req.org.id, before: { current: true }, after: { current: false, validUntil: until }, reason: 'marked departed' }, req);
        verification.claims.closePeriod(c.id, { until, at: Date.now() }); // history is NOT erased — the verified period closes
      }
      // Powers tied to the relationship end immediately.
      for (const a of reads.admins.activeFor(req.org.id, req.params.userId)) {
        verification.admins.revoke(a.id, { at: Date.now(), by: req.orgUser.id });
        verEvent('admin.revoked', { orgId: req.org.id, subjectId: a.userId, reason: 'departed' }, req);
      }
    });
    notify({ kind: 'org_user', id: req.params.userId }, 'verification', `${req.org.name} recorded you as departed. Your verified history stays on your profile; if this is wrong you can dispute it from Verification.`, claims[0].id);
    res.json({ closed: claims.length, note: 'Current badges end now; the historical verified period remains. The person can dispute this.' });
  });

  // ================================================ official domains
  orgRouter.get('/verification/domains', (req, res) => {
    if (!requireVer(req, res, 'verification_viewer')) return;
    res.json({
      domains: reads.domains.forOrg(req.org.id),
      requests: reads.domainRequests.forOrg(req.org.id),
    });
  });

  orgRouter.post('/verification/domains', async (req, res) => {
    if (!requireVer(req, res, 'verification_admin')) return;
    for (const k of ['domain', 'challengeEmail']) if (!(req.body?.[k] === undefined || req.body?.[k] === null || typeof req.body[k] === 'string')) return fieldInvalid(res, k, `${k} is text.`);
    const domain = normalizeDomain(req.body?.domain);
    const challengeEmail = String(req.body?.challengeEmail ?? '').trim().toLowerCase();
    if (!domain || !domain.includes('.') || domain.length > L.domain) return res.status(400).json({ error: 'DOMAIN_INVALID' });
    if (isFreeMail(domain) || isDisposable(domain)) return res.status(422).json({ error: 'SHARED_PROVIDER_DOMAIN', message: 'Free/shared email providers cannot be organisation domains.' });
    const mine = verifiedDomainsOf(req.org.id);
    if (reads.domains.has(req.org.id, domain)) return res.status(409).json({ error: 'DOMAIN_EXISTS' });
    const otherOrg = reads.domains.verifiedElsewhere(domain, req.org.id);
    const verifiedRoot = mine.find((d) => domainCovered(domain, d));
    const highRisk = !verifiedRoot || !!otherOrg; // first/root domain or contested → human review
    const reasons = [...(otherOrg ? ['DOMAIN_OWNERSHIP_AMBIGUOUS'] : []), ...(!verifiedRoot ? ['HIGH_RISK_ADMIN_CHANGE'] : [])];
    let status = highRisk ? 'requires_human_review' : 'email_challenge';
    const challengeOk = status === 'email_challenge' && !emailProblem(challengeEmail) && domainOfEmail(challengeEmail) === domain;
    if (status === 'email_challenge' && !challengeOk) { status = 'requires_human_review'; if (!reasons.includes('DOMAIN_OWNERSHIP_AMBIGUOUS')) reasons.push('DOMAIN_OWNERSHIP_AMBIGUOUS'); }
    const id = nextId('vdom');
    const r = unit(() => {
      const created = verification.domainRequests.create({
        id, orgId: req.org.id, domain, requestedBy: req.orgUser.id, status, reviewReasons: reasons,
        method: null, createdAt: Date.now(), decidedAt: null, decidedBy: null, decidedById: null,
      });
      verEvent('organisation.domain_added', { orgId: req.org.id, after: { domain, status: highRisk ? 'requires_human_review' : 'email_challenge' } }, req);
      return created;
    });
    if (challengeOk) {
      const secret = mintToken({ purpose: 'domain_email', email: challengeEmail, orgId: req.org.id, refId: r.id });
      await mailer.send({ to: challengeEmail, subject: `Confirm ${domain} for ${req.org.name} on ScoutBox`, text: `Confirmation code for adding ${domain} as an official ${req.org.name} domain: ${secret}\n\nSingle use, expires in 30 minutes.` });
    }
    res.status(201).json({
      request: r,
      note: r.status === 'requires_human_review'
        ? 'Root or contested domain changes are reviewed by Trust & Safety before they take effect.'
        : 'A confirmation code went to the mailbox on that domain.',
    });
  });

  orgRouter.post('/verification/domains/:id/confirm', (req, res) => {
    if (!requireVer(req, res, 'verification_admin')) return;
    const r = onlyOrg(req, reads.domainRequests.byId(req.params.id));
    if (!r) return res.status(404).json({ error: 'DOMAIN_REQUEST_NOT_FOUND' });
    if (r.status !== 'email_challenge') return res.status(409).json({ error: 'NOT_IN_EMAIL_CHALLENGE' });
    if (!(req.body?.code === undefined || req.body?.code === null || typeof req.body.code === 'string')) return fieldInvalid(res, 'code', 'code is text.');
    const peek = ctx.peekToken({ purpose: 'domain_email', secret: req.body?.code });
    if (peek.error || peek.token.refId !== r.id) {
      if (!peek.error) ctx.useToken(peek.token); // a valid code for another request is spent
      vmetric('emailChallengeFailures');
      return res.status(401).json({ error: peek.error ?? 'TOKEN_WRONG_PURPOSE' });
    }
    unit(() => {
      ctx.useToken(peek.token);
      verification.domainRequests.confirmByEmail(r.id, { at: Date.now() });
      if (!reads.domains.has(req.org.id, r.domain)) verification.domains.add(req.org.id, { domain: r.domain, status: 'verified', method: 'official_domain_email', verifiedAt: Date.now(), addedBy: req.orgUser.id });
      createClaim({
        subjectType: 'org', subjectId: req.org.id, claimType: 'ORGANISATION_DOMAIN', organisationId: req.org.id,
        status: 'verified', verificationMethod: 'official_domain_email', verifiedAt: Date.now(),
        verifiedBy: { kind: 'org_admin', id: req.orgUser.id }, metadata: { domain: r.domain },
      }, req);
      verEvent('organisation.domain_verified', { orgId: req.org.id, after: { domain: r.domain } }, req);
    });
    res.json({ domain: r.domain, status: 'verified' });
  });

  orgRouter.post('/verification/domains/:id/remove', (req, res) => {
    const list = reads.domains.forOrg(req.org.id);
    const d = list.find((x) => x.domain === normalizeDomain(req.params.id) || x.domain === req.params.id);
    if (!d) return res.status(404).json({ error: 'DOMAIN_NOT_FOUND' });
    const isRoot = !list.some((o) => o.domain !== d.domain && d.domain.endsWith(`.${o.domain}`));
    if (!requireVer(req, res, isRoot ? 'verification_root_admin' : 'verification_admin', { root: isRoot })) return;
    unit(() => {
      verification.domains.remove(req.org.id, d.domain);
      verEvent('organisation.domain_removed', { orgId: req.org.id, before: { domain: d.domain } }, req);
    });
    res.json({ removed: d.domain });
  });

  // ======================================== verification administrators
  orgRouter.get('/verification/admins', (req, res) => {
    if (!requireVer(req, res, 'verification_viewer')) return;
    res.json({
      items: reads.admins.forOrg(req.org.id).map((a) => ({
        ...a, person: { id: a.userId, name: byId.user(a.userId)?.name ?? '(removed)' },
      })),
      transfers: reads.rootTransfers.forOrg(req.org.id),
    });
  });

  orgRouter.post('/verification/admins', (req, res) => {
    const { userId, level } = req.body ?? {};
    if (!VER_LEVELS.includes(level)) return res.status(400).json({ error: 'LEVEL_UNKNOWN' });
    if (typeof userId !== 'string') return res.status(404).json({ error: 'USER_NOT_FOUND' });
    const needsRoot = ['verification_admin', 'verification_root_admin'].includes(level);
    if (!requireVer(req, res, needsRoot ? 'verification_root_admin' : 'verification_admin', { root: needsRoot })) return;
    if (userId === req.orgUser.id) {
      verEvent('security.self_verification_blocked', { orgId: req.org.id, subjectId: userId, reason: 'self-promotion attempt' }, req);
      return res.status(403).json({ error: 'SELF_PROMOTION_FORBIDDEN', message: 'You cannot change your own verification authority.' });
    }
    const target = byId.user(userId, (u) => u.orgId === req.org.id && !u.removedAt);
    if (!target) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    if (level === 'verification_root_admin') {
      // Dual control: a second root admin (or Trust & Safety) must approve.
      if (reads.rootTransfers.hasPending(req.org.id)) {
        return res.status(409).json({ error: 'TRANSFER_ALREADY_PENDING' });
      }
      const t = unit(() => {
        const created = verification.rootTransfers.create({ id: nextId('vrtx'), orgId: req.org.id, toUserId: userId, proposedBy: req.orgUser.id, status: 'pending', createdAt: Date.now(), approvedBy: null, approvedAt: null });
        verEvent('admin.invited', { orgId: req.org.id, subjectId: userId, after: { level, dualControl: 'pending' } }, req);
        return created;
      });
      return res.status(202).json({ transfer: t, note: 'Root authority changes need a second approval: another root administrator, or Trust & Safety.' });
    }
    if (reads.admins.activeFor(req.org.id, userId).some((a) => a.level === level)) {
      return res.status(409).json({ error: 'ALREADY_GRANTED' });
    }
    const a = unit(() => {
      const created = verification.admins.create({ id: nextId('vadm'), orgId: req.org.id, userId, level, status: 'active', invitedBy: req.orgUser.id, createdAt: Date.now(), acceptedAt: Date.now(), revokedAt: null, revokedBy: null });
      verEvent('admin.accepted', { orgId: req.org.id, subjectId: userId, after: { level } }, req);
      return created;
    });
    notify({ kind: 'org_user', id: userId }, 'verification', `You now hold ${level.replace(/_/g, ' ')} authority for ${req.org.name}.`, a.id);
    res.status(201).json({ admin: a });
  });

  orgRouter.post('/verification/root-transfers/:id/approve', (req, res) => {
    if (!requireVer(req, res, 'verification_root_admin', { root: true })) return;
    const t = onlyOrg(req, reads.rootTransfers.byId(req.params.id));
    if (!t) return res.status(404).json({ error: 'TRANSFER_NOT_FOUND' });
    if (t.status !== 'pending') return res.status(409).json({ error: 'TRANSFER_NOT_PENDING' });
    if (t.proposedBy === req.orgUser.id) {
      return res.status(403).json({ error: 'DUAL_CONTROL_REQUIRED', message: 'The approver must be a different root administrator than the proposer.' });
    }
    if (t.toUserId === req.orgUser.id) {
      return res.status(403).json({ error: 'SELF_PROMOTION_FORBIDDEN', message: 'The beneficiary cannot approve their own root authority.' });
    }
    const [approved, a] = unit(() => {
      const tr = verification.rootTransfers.approve(t.id, { at: Date.now(), by: req.orgUser.id });
      // An existing active root grant is not duplicated (one active grant per person and level).
      const held = reads.admins.activeFor(req.org.id, t.toUserId).find((x) => x.level === 'verification_root_admin');
      const grant = held ?? verification.admins.create({ id: nextId('vadm'), orgId: req.org.id, userId: t.toUserId, level: 'verification_root_admin', status: 'active', invitedBy: t.proposedBy, createdAt: Date.now(), acceptedAt: Date.now(), revokedAt: null, revokedBy: null });
      verEvent('admin.accepted', { orgId: req.org.id, subjectId: t.toUserId, after: { level: 'verification_root_admin', dualControl: `approved by ${req.orgUser.id}` } }, req);
      return [tr, grant];
    });
    res.json({ transfer: approved, admin: a });
  });

  orgRouter.post('/verification/admins/:id/revoke', (req, res) => {
    const a = onlyOrg(req, reads.admins.byId(req.params.id));
    if (!a) return res.status(404).json({ error: 'ADMIN_NOT_FOUND' });
    const isRootRow = a.level === 'verification_root_admin';
    if (!requireVer(req, res, isRootRow ? 'verification_root_admin' : 'verification_admin', { root: isRootRow })) return;
    if (a.userId === req.orgUser.id) return res.status(403).json({ error: 'SELF_REVOKE_FORBIDDEN', message: 'Another administrator (or Trust & Safety) must change your authority.' });
    if (a.status !== 'active') return res.status(409).json({ error: 'ALREADY_REVOKED' });
    if (isRootRow) {
      if (reads.admins.activeRootCount(req.org.id) <= 1) {
        return res.status(409).json({ error: 'LAST_ROOT_ADMIN', message: 'An organisation cannot remove its final root administrator itself — Trust & Safety handles root recovery so the organisation is never orphaned.' });
      }
    }
    const revoked = unit(() => {
      const next = verification.admins.revoke(a.id, { at: Date.now(), by: req.orgUser.id });
      verEvent('admin.revoked', { orgId: req.org.id, subjectId: a.userId, reason: String(req.body?.reason ?? 'revoked by organisation') }, req);
      return next;
    });
    res.json({ admin: revoked, note: 'Authority ends immediately. Claims this person previously approved keep their provenance and can be reviewed (Trust & Safety cascade tools).' });
  });

  // ========================================== conflict declarations
  orgRouter.post('/verification/conflicts', (req, res) => {
    const { kind, subject, note } = req.body ?? {};
    const KINDS = CONFLICT_KINDS;
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'KIND_UNKNOWN', kinds: KINDS });
    for (const [k, v] of [['subject', subject], ['note', note]]) if (!(v === undefined || v === null || typeof v === 'string')) return fieldInvalid(res, k, `${k} is text.`);
    const c = verification.conflicts.create({ id: nextId('vcoi'), userId: req.orgUser.id, orgId: req.org.id, kind, subject: String(subject ?? '').slice(0, L.subject), note: String(note ?? '').slice(0, L.note), createdAt: Date.now(), withdrawnAt: null });
    res.status(201).json({ conflict: c, note: 'Declarations are explicit and visible to your organisation’s verification administrators and Trust & Safety — never inferred, never public.' });
  });
  orgRouter.get('/verification/conflicts', (req, res) => {
    const admin = hasVerLevel(req.org.id, req.orgUser.id, 'verification_reviewer');
    res.json({ items: admin ? reads.conflicts.forOrg(req.org.id) : reads.conflicts.forOrgUser(req.org.id, req.orgUser.id) });
  });
  orgRouter.post('/verification/conflicts/:id/withdraw', (req, res) => {
    const found = reads.conflicts.byId(req.params.id);
    const c = found && found.orgId === req.org.id && found.userId === req.orgUser.id ? found : null;
    if (!c) return res.status(404).json({ error: 'CONFLICT_NOT_FOUND' });
    if (c.withdrawnAt) return res.status(409).json({ error: 'ALREADY_WITHDRAWN' });
    const withdrawn = verification.conflicts.withdraw(c.id, { at: Date.now() });
    res.json({ conflict: withdrawn });
  });

  // ============================================== squad invitations
  const INVITES_PER_DAY = 20;
  orgRouter.post('/verification/player-invites', async (req, res) => {
    if (!orgCanAttest(req.org)) return res.status(403).json({ error: 'ORG_NOT_ELIGIBLE', message: 'Only a verified organisation can send squad invitations.' });
    const today = reads.playerInvites.countSince(req.org.id, Date.now() - 86_400_000);
    if (today >= INVITES_PER_DAY) return res.status(429).json({ error: 'INVITE_RATE_LIMIT', message: `Deterministic limit: ${INVITES_PER_DAY} invitations per organisation per day.` });
    const { name, squad, playerId } = req.body ?? {};
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : req.body?.email;
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'NAME_REQUIRED' });
    if (email && (typeof email !== 'string' || emailProblem(email))) return res.status(400).json({ error: 'EMAIL_SYNTAX' }); // a string only: emailProblem would coerce an array
    if (!(squad === undefined || squad === null || typeof squad === 'string')) return fieldInvalid(res, 'squad', 'squad is text.');
    if (!(playerId === undefined || playerId === null || playerId === '' || typeof playerId === 'string')) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    // Recipient binding: when the invite targets an EXISTING ScoutBox
    // player, the token is bound to that identity and nobody else can attach
    // it. (Player targeting uses the standing visibility rules — an invite
    // is not a discovery bypass.)
    let targetPlayer = null;
    if (playerId) {
      targetPlayer = findPlayer(playerId);
      if (!targetPlayer) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
      if (!visibleToOrg(targetPlayer, req.org) || isBlocked(targetPlayer.id, req.org.id)) {
        return res.status(404).json({ error: 'PLAYER_NOT_FOUND' }); // concealment — no probing hidden players
      }
    }
    let secret = null;
    const inv = unit(() => {
      const created = verification.playerInvites.create({
        id: nextId('vpin'), orgId: req.org.id, byUserId: req.orgUser.id, byName: (req.orgUser.name == null ? null : String(req.orgUser.name).slice(0, L.name)),
        name: String(name).trim().slice(0, L.inviteeName), squad: String(squad ?? '').slice(0, L.squad),
        status: 'pending', playerId: null, targetPlayerId: targetPlayer?.id ?? null, guardianApproved: null,
        createdAt: Date.now(), expiresAt: Date.now() + 14 * 86_400_000, acceptedAt: null,
      });
      secret = mintToken({
        purpose: 'player_invite', email: email ?? null, orgId: req.org.id, refId: created.id,
        subjectKind: targetPlayer ? 'player' : null, subjectId: targetPlayer?.id ?? null,
        ttlMs: 14 * 86_400_000,
      });
      return created;
    });
    if (email) await mailer.send({ to: email, subject: `${req.org.name} invited you to ScoutBox`, text: `Hi ${inv.name},\n\n${req.orgUser.name} at ${req.org.name} invites you to join ScoutBox${inv.squad ? ` (${inv.squad})` : ''}.\n\nInvitation code: ${secret}\n\nJoining is your choice — an invitation gives the club no control over your profile. Under-18s join through a parent or guardian.` });
    res.status(201).json({ invite: inv, ...(email ? {} : { code: secret, note: 'No email supplied — hand the single-use code to the player (or their guardian) directly.' }) });
  });
  orgRouter.get('/verification/player-invites', (req, res) => {
    res.json({ items: reads.playerInvites.forOrg(req.org.id) });
  });

  // Acceptance NEVER creates identity claims and never bypasses guardianship:
  // adults accept themselves; a minor's invite can only be accepted by their
  // guardian (existing DOB/country adult check — no new age system).
  playerRouter.post('/invites/accept', (req, res) => {
    if (!isAdult(req.player)) {
      return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Your guardian accepts club invitations for you.' });
    }
    return acceptInvite(res, req.body?.code, req.player, null, req.body?.email ?? null);
  });
  guardianRouter.post('/invites/accept', (req, res) => {
    const child = byId.player(req.body?.childId, (p) => req.guardian.childIds.includes(p.id));
    if (!child) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    return acceptInvite(res, req.body?.code, child, req.guardian);
  });
  function acceptInvite(res, code, player, guardian, claimedEmail = null) {
    // Recipient binding: peek first, run EVERY binding check, and only
    // then consume — a wrong-recipient attempt must never burn the rightful
    // recipient's single-use secret.
    if (!(code === undefined || code === null || typeof code === 'string')) return res.status(404).json({ error: 'TOKEN_UNKNOWN' });
    const out = ctx.peekToken({ purpose: 'player_invite', secret: code });
    if (out.error) return res.status(out.error === 'TOKEN_EXPIRED' ? 410 : 404).json({ error: out.error });
    const found = reads.playerInvites.byId(out.token.refId);
    const inv = found && found.status === 'pending' && !found.playerId ? found : null;
    if (!inv) return res.status(404).json({ error: 'INVITE_NOT_FOUND' });
    const org = orgOf(inv.orgId);
    if (!org || org.suspended) return res.status(403).json({ error: 'ORG_UNAVAILABLE' });
    // 1. Identity-targeted invite: only the named player (adult flow) or that
    //    exact child through their EXISTING guardian relationship may accept.
    if (out.token.subjectId && out.token.subjectId !== player.id) {
      verEvent('security.self_verification_blocked', { orgId: inv.orgId, subjectId: player.id, reason: 'invite recipient mismatch (identity-bound)', after: { invite: inv.id } });
      return res.status(403).json({ error: 'INVITE_RECIPIENT_MISMATCH', message: 'This invitation names a different recipient. Codes cannot be transferred.' });
    }
    // 2. Address-targeted invite: the accepting side must be associated with
    //    the recipient mailbox. Guardians have verified account emails — the
    //    guardian's own address must match. Player accounts carry no email,
    //    so an accepting adult confirms the recipient address; possession of
    //    the code alone is not enough. (Documented limitation: for adults
    //    this is address knowledge + code possession, not mailbox re-proof.)
    if (out.token.email) {
      const supplied = guardian ? String(guardian.email ?? '').toLowerCase() : String(claimedEmail ?? '').toLowerCase();
      if (supplied !== out.token.email) {
        return res.status(403).json({ error: 'INVITE_RECIPIENT_MISMATCH', message: guardian ? 'This invitation was addressed to a different guardian email.' : 'Confirm the email address the invitation was sent to.' });
      }
    }
    const accepted = unit(() => {
      ctx.useToken(out.token); // all binding checks passed — consume now
      const next = verification.playerInvites.accept(inv.id, { playerId: player.id, at: Date.now(), guardianId: guardian?.id ?? null });
      verEvent('claim.created', { orgId: inv.orgId, subjectId: player.id, after: { invite: inv.id, guardianApproved: !!guardian } });
      notify({ kind: 'org_user', id: inv.byUserId }, 'verification', `${player.name} accepted your squad invitation${guardian ? ' (guardian-approved)' : ''}.`, inv.id);
      return next;
    });
    return res.json({ invite: accepted, note: 'Joining links nothing else: club visibility, contact and consent all still follow the standing safeguarding rules.' });
  }

  // ================================================ coach references
  orgRouter.post('/verification/references', (req, res) => {
    // The author needs a CURRENT, EFFECTIVE verified role at this org — and
    // the player must already be visible under the standing safeguarding
    // rules. Verification proves facts; it grants no extra access.
    const roleClaim = userClaims(req.orgUser.id).find((c) => c.organisationId === req.org.id && /ROLE|AFFILIATION/.test(c.claimType) && effectiveStatus(c, { org: req.org }).current);
    if (!roleClaim) return res.status(403).json({ error: 'VERIFIED_ROLE_REQUIRED', message: 'Structured references need a currently verified role at this organisation.' });
    const p = findPlayer(req.body?.playerId);
    if (!p) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!visibleToOrg(p, req.org) || isBlocked(p.id, req.org.id)) {
      return res.status(403).json({ error: 'UNDER_18_WALL', message: 'A verified role does not widen player visibility — the standing consent and safeguarding rules decide who you can reference.' });
    }
    const { relationship, capacity, fromYear, toYear, strengths, development, summary } = req.body ?? {};
    for (const [k, v] of [['relationship', relationship], ['summary', summary], ['capacity', capacity], ['strengths', strengths], ['development', development]]) {
      if (!(v === undefined || v === null || typeof v === 'string')) return fieldInvalid(res, k, `${k} is text.`);
    }
    if (!relationship?.trim() || !summary?.trim()) return res.status(400).json({ error: 'FIELDS_REQUIRED', message: 'relationship and summary are required.' });
    const yearOf = (v) => (v === undefined || v === null || v === '' ? { ok: true, year: null } : (Number.isInteger(v) || (typeof v === 'string' && /^\d{4}$/.test(v.trim()))) && Number(v) >= 1900 && Number(v) <= 2100 ? { ok: true, year: Number(v) } : { ok: false });
    const fy = yearOf(fromYear); if (!fy.ok) return fieldInvalid(res, 'fromYear', 'fromYear is a year between 1900 and 2100.');
    const ty = yearOf(toYear); if (!ty.ok) return fieldInvalid(res, 'toYear', 'toYear is a year between 1900 and 2100.');
    const ref = unit(() => {
      const created = verification.references.create({
        id: nextId('vref'), version: 1, supersedesId: null, playerId: p.id, playerName: p.name == null ? null : String(p.name).slice(0, L.name),
        coachUserId: req.orgUser.id, coachName: (req.orgUser.name == null ? null : String(req.orgUser.name).slice(0, L.name)), orgId: req.org.id, orgName: String(req.org.name).slice(0, L.name),
        roleAtTime: roleClaim.role ?? (req.orgUser.role == null ? null : String(req.orgUser.role).slice(0, L.name)),
        provenanceSnapshot: { // snapshot at submission — later changes never rewrite it
          claimId: roleClaim.id, claimType: roleClaim.claimType, status: 'verified',
          method: roleClaim.verificationMethod, verifiedAt: roleClaim.verifiedAt, snapshotAt: Date.now(),
        },
        relationship: String(relationship).slice(0, L.relationship), capacity: String(capacity ?? '').slice(0, L.capacity),
        fromYear: fy.year, toYear: ty.year,
        structured: { strengths: String(strengths ?? '').slice(0, L.strengths), development: String(development ?? '').slice(0, L.development), summary: String(summary).slice(0, L.summary) },
        status: 'active', withdrawnAt: null, withdrawReason: null, createdAt: Date.now(),
      });
      verEvent('claim.created', { orgId: req.org.id, subjectId: p.id, after: { reference: created.id, provenance: created.provenanceSnapshot.claimId } }, req);
      // Guardian routing for minors — existing DOB/country logic, untouched.
      if (isAdult(p)) notify({ kind: 'player', id: p.id }, 'verification', `${req.orgUser.name} (${req.org.name}) added a structured reference to your profile.`, created.id);
      else if (p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'verification', `${req.orgUser.name} (verified at ${req.org.name}) added a structured reference for ${p.name}. You can review it in the app.`, created.id);
      return created;
    });
    res.status(201).json({ reference: ref });
  });

  orgRouter.get('/verification/references', (req, res) => {
    res.json({ items: reads.references.forOrg(req.org.id) });
  });

  orgRouter.post('/verification/references/:id/withdraw', (req, res) => {
    const ref = ownReference(req, reads.references.byId(req.params.id));
    if (!ref) return res.status(404).json({ error: 'REFERENCE_NOT_FOUND' });
    if (ref.status !== 'active') return res.status(409).json({ error: 'NOT_ACTIVE' });
    if (typeof req.body?.reason !== 'string' || !req.body.reason.trim()) return res.status(400).json({ error: 'REASON_REQUIRED' });
    const withdrawn = unit(() => {
      const next = verification.references.withdraw(ref.id, { at: Date.now(), reason: req.body.reason.slice(0, L.withdrawReason) });
      verEvent('claim.corrected', { orgId: req.org.id, subjectId: ref.playerId, before: { reference: ref.id, status: 'active' }, after: { status: 'withdrawn' }, reason: next.withdrawReason }, req);
      return next;
    });
    res.json({ reference: withdrawn, note: 'Withdrawal is an event — the original text and its provenance remain in the record.' });
  });

  orgRouter.post('/verification/references/:id/correct', (req, res) => {
    const old = ownReference(req, reads.references.byId(req.params.id));
    if (!old) return res.status(404).json({ error: 'REFERENCE_NOT_FOUND' });
    if (old.status !== 'active') return res.status(409).json({ error: 'NOT_ACTIVE' });
    for (const k of ['strengths', 'development', 'summary']) if (!(req.body?.[k] === undefined || req.body?.[k] === null || typeof req.body[k] === 'string')) return fieldInvalid(res, k, `${k} is text.`);
    if (typeof req.body?.summary === 'string' && !req.body.summary.trim()) return res.status(400).json({ error: 'FIELDS_REQUIRED', message: 'A reference keeps its summary.' });
    const next = unit(() => {
      verification.references.supersede(old.id);
      const created = verification.references.create({
        ...structuredClone(old), id: nextId('vref'), version: old.version + 1, supersedesId: old.id,
        structured: {
          strengths: String(req.body?.strengths ?? old.structured.strengths).slice(0, L.strengths),
          development: String(req.body?.development ?? old.structured.development).slice(0, L.development),
          summary: String(req.body?.summary ?? old.structured.summary).slice(0, L.summary),
        },
        createdAt: Date.now(),
      });
      verEvent('claim.corrected', { orgId: req.org.id, subjectId: old.playerId, before: { reference: old.id }, after: { reference: created.id, version: created.version } }, req);
      return created;
    });
    res.json({ reference: next, superseded: old.id, note: 'Corrections create a new version — the original is never silently edited.' });
  });

  const ownReference = (req, r) => (r && r.orgId === req.org.id && r.coachUserId === req.orgUser.id ? r : null);
  // Player/guardian read their references, with honest provenance wording.
  const refPlayerView = (r) => ({
    id: r.id, version: r.version, coachName: r.coachName, orgName: r.orgName, roleAtTime: r.roleAtTime,
    relationship: r.relationship, capacity: r.capacity, fromYear: r.fromYear, toYear: r.toYear,
    structured: r.structured, status: r.status, createdAt: r.createdAt,
    provenance: (() => {
      const claim = reads.claims.byId(r.provenanceSnapshot.claimId);
      const stillCurrent = claim && effectiveStatus(claim, { org: orgOf(r.orgId) }).current;
      return stillCurrent
        ? `Coach's ${r.orgName} affiliation is verified.`
        : 'Coach affiliation was verified when this reference was submitted.';
    })(),
  });
  playerRouter.get('/references', (req, res) => {
    res.json({ items: reads.references.forPlayer(req.player.id).filter((r) => r.status !== 'superseded').map(refPlayerView) });
  });
  guardianRouter.get('/children/:id/references', (req, res) => {
    if (!req.guardian.childIds.includes(req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    res.json({ items: reads.references.forPlayer(req.params.id).filter((r) => r.status !== 'superseded').map(refPlayerView) });
  });

  // ====================================== root organisation bootstrap
  // Public application — deterministic checks first, humans last. The
  // applicant gets a single-use applicant secret binding follow-up calls.
  app.post('/auth/org/verification/apply', async (req, res) => {
    const b = req.body ?? {};
    const required = ['orgName', 'orgType', 'country', 'website', 'applicantName', 'applicantRole', 'workEmail'];
    for (const k of [...required, 'federation', 'domain', 'officialContact']) if (!(b[k] === undefined || b[k] === null || typeof b[k] === 'string')) return fieldInvalid(res, k, `${k} is text.`);
    const missing = required.filter((k) => !String(b[k] ?? '').trim());
    if (missing.length) return res.status(400).json({ error: 'FIELDS_REQUIRED', missing });
    // Declarations are a fixed statement: { authorised: true|false }, or none.
    const decl = b.declarations;
    if (!(decl === undefined || decl === null || (typeof decl === 'object' && !Array.isArray(decl) && Object.keys(decl).every((k) => k === 'authorised') && typeof decl.authorised === 'boolean'))) {
      return fieldInvalid(res, 'declarations', 'declarations is { authorised: true } or { authorised: false }.');
    }
    const ORG_TYPES = ['professional club', 'academy', 'grassroots club', 'federation/association', 'agency', 'other approved football organisation'];
    if (!ORG_TYPES.includes(b.orgType)) return res.status(400).json({ error: 'ORG_TYPE_UNKNOWN', types: ORG_TYPES });
    const problem = emailProblem(b.workEmail);
    if (problem) return res.status(400).json({ error: problem });
    const domain = normalizeDomain(b.domain || b.website);
    if (domain.length > L.domain) return fieldInvalid(res, 'domain', 'The domain is too long.');
    if (String(b.workEmail).length > L.email) return res.status(400).json({ error: 'EMAIL_TOO_LONG' });
    const emailDom = domainOfEmail(b.workEmail);
    // ---- deterministic automated checks. No network fetch happens here:
    // DNS/https probing from this environment is not implemented — recorded
    // honestly as not_configured rather than pretended.
    const dupOrg = ctx.orgs.byName(String(b.orgName));
    const dupDomainOrg = domain ? reads.domains.verifiedElsewhere(domain) : null;
    const dupRequest = reads.rootRequests.openDuplicate(domain, String(b.orgName).trim().toLowerCase());
    const checks = {
      emailSyntax: 'passed',
      emailDomainAlignment: domainCovered(emailDom, domain) ? 'passed' : 'mismatch',
      freeEmailProvider: isFreeMail(emailDom) ? 'flagged' : 'passed',
      disposableEmail: isDisposable(emailDom) ? 'flagged' : 'passed',
      domainNormalized: domain || '(none)',
      dnsOwnership: 'not_configured', // no safe DNS/https probe in this environment — never faked
      duplicateOrganisation: dupOrg ? 'flagged' : 'passed',
      duplicateRequest: dupRequest ? 'flagged' : 'passed',
      domainAlreadyVerifiedElsewhere: dupDomainOrg ? 'flagged' : 'passed',
      evidenceCompleteness: 'pending_email_proof',
    };
    const flags = riskFlags({ email: b.workEmail, orgDomains: domain ? [domain] : [] });
    const applicantSecret = randomHex(18);
    let secret = null;
    const r = unit(() => {
      const created = verification.rootRequests.create({
        id: nextId('vroot'), status: 'collecting_evidence',
        orgName: String(b.orgName).trim().slice(0, L.orgName), orgType: b.orgType, country: String(b.country).slice(0, L.country),
        federation: String(b.federation ?? '').slice(0, L.federation) || null, website: String(b.website).slice(0, L.website),
        domain, applicantName: String(b.applicantName).trim().slice(0, L.applicantName), applicantRole: String(b.applicantRole).trim().slice(0, L.applicantRole),
        workEmail: String(b.workEmail).toLowerCase(), officialContact: String(b.officialContact ?? '').slice(0, L.officialContact) || null,
        declarations: decl ? { authorised: decl.authorised } : null, checks, riskFlags: flags,
        reviewReasons: [], emailProved: false, existingOrgId: dupOrg?.id ?? null,
        applicantSecretHash: sha256(applicantSecret),
        createdAt: Date.now(), decidedAt: null, decidedBy: null, decidedById: null, decisionAttribution: null, decisionReason: null,
        resultOrgId: null, resultUserId: null, identityLink: null,
      });
      secret = mintToken({ purpose: 'root_email', email: created.workEmail, refId: created.id });
      return created;
    });
    await mailer.send({ to: r.workEmail, subject: `Verify your email for the ${r.orgName} ScoutBox application`, text: `Your ScoutBox organisation-application code is ${secret}\n\nSingle use, expires in 30 minutes.` });
    verEvent('review.requested', { orgId: null, subjectId: null, after: { rootRequest: r.id, checks } });
    res.status(201).json({
      requestId: r.id, applicantSecret, checks,
      note: 'Confirm the emailed code, add supporting evidence, then submit. Domain/email control is evidence of mailbox control — it does not by itself verify the organisation.',
    });
  });

  const rootReqBySecret = (req, res) => {
    const r = reads.rootRequests.byId(req.params.id);
    if (!r || r.applicantSecretHash !== sha256(String(req.body?.applicantSecret ?? req.query?.applicantSecret ?? ''))) {
      res.status(404).json({ error: 'REQUEST_NOT_FOUND' }); // concealment — no probing which ids exist
      return null;
    }
    return r;
  };

  app.post('/auth/org/verification/apply/:id/confirm-email', (req, res) => {
    const r = rootReqBySecret(req, res); if (!r) return;
    if (!(req.body?.code === undefined || req.body?.code === null || typeof req.body.code === 'string')) return fieldInvalid(res, 'code', 'code is text.');
    const peek = ctx.peekToken({ purpose: 'root_email', secret: req.body?.code, email: r.workEmail });
    if (peek.error || peek.token.refId !== r.id) {
      if (!peek.error) ctx.useToken(peek.token);
      vmetric('emailChallengeFailures');
      return res.status(401).json({ error: peek.error ?? 'TOKEN_WRONG_PURPOSE' });
    }
    unit(() => {
      ctx.useToken(peek.token);
      verification.rootRequests.proveEmail(r.id);
      verEvent('email.challenge_passed', { after: { rootRequest: r.id } });
    });
    res.json({ emailProved: true });
  });

  app.post('/auth/org/verification/apply/:id/evidence', (req, res) => {
    const r = rootReqBySecret(req, res); if (!r) return;
    if (!['collecting_evidence', 'requires_human_review'].includes(r.status)) return res.status(409).json({ error: 'REQUEST_CLOSED' });
    const { dataUrl, filename, note } = req.body ?? {};
    if (!(note === undefined || note === null || typeof note === 'string')) return fieldInvalid(res, 'note', 'note is text.');
    if (!(filename === undefined || filename === null || typeof filename === 'string')) return fieldInvalid(res, 'filename', 'filename is text.');
    let fileFields = {};
    if (dataUrl) {
      const stored = storeEvidenceFile(dataUrl, filename, req);
      if (stored.error) return res.status(422).json({ error: stored.error });
      fileFields = stored;
    } else if (!note?.trim()) return res.status(400).json({ error: 'EVIDENCE_REQUIRED' });
    const dup = fileFields.sha256 && reads.evidence.digestSeen(fileFields.sha256);
    const ev = unit(() => {
      const added = addEvidence({
        type: 'document', source: 'root_application', suppliedByKind: 'applicant', suppliedById: r.id,
        orgId: null, claimIds: [], ...fileFields, meta: { note: String(note ?? '').slice(0, L.note), rootRequest: r.id },
        visibility: 'trust_and_safety',
      });
      if (dup) verification.rootRequests.addRiskFlags(r.id, { codes: ['DUPLICATE_EVIDENCE_HASH'] });
      return added;
    });
    res.status(201).json({ evidence: { id: ev.id, checks: ev.checks } });
  });

  app.post('/auth/org/verification/apply/:id/submit', (req, res) => {
    const r = rootReqBySecret(req, res); if (!r) return;
    if (r.status !== 'collecting_evidence') return res.status(409).json({ error: 'ALREADY_SUBMITTED' });
    if (!r.emailProved) return res.status(422).json({ error: 'EMAIL_NOT_PROVED', message: 'Confirm the emailed code first.' });
    // A first administrator with no existing ScoutBox authority is
    // ALWAYS a human decision. Everything else was prepared automatically.
    const { reasons } = decideReview({
      claimType: 'ORGANISATION_IDENTITY', isFirstOrgAdmin: true,
      duplicateOrg: r.checks.duplicateOrganisation === 'flagged' || r.checks.domainAlreadyVerifiedElsewhere === 'flagged',
      domainAmbiguous: r.checks.emailDomainAlignment === 'mismatch',
      riskFlagCount: r.riskFlags.length,
    });
    unit(() => {
      verification.rootRequests.submitForReview(r.id, { reviewReasons: reasons });
      verEvent('review.requested', { after: { rootRequest: r.id, reasons } });
    });
    vmetric('routedToHumanReview');
    res.json({
      status: 'requires_human_review', reasons,
      explanation: `ScoutBox has confirmed control of a ${domainOfEmail(r.workEmail)} mailbox, but an authorised organisation administrator has not yet been established — Trust & Safety reviews the application and the evidence before the first administrator is appointed.`,
    });
  });

  app.get('/auth/org/verification/apply/:id/status', (req, res) => {
    const r = reads.rootRequests.byId(req.params.id);
    if (!r || r.applicantSecretHash !== sha256(String(req.query.applicantSecret ?? ''))) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
    res.json({ id: r.id, status: r.status, checks: r.checks, reviewReasons: r.reviewReasons, decisionReason: r.decisionReason, resultOrgId: r.resultOrgId });
  });
}
