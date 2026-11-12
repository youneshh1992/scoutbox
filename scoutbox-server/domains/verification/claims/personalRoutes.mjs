import { parseDateOrInstant, isAbsent } from '../../../temporal.mjs';
import { filled, inputOrRefuse, listedIds, presentOrRefuse } from '../../platform/schemas.mjs';
import {
  emailProblem,
  domainOfEmail,
  isFreeMail,
  isDisposable,
  domainCovered,
  riskFlags,
  decideReview,
  evidenceCompleteness,
  sha256,
} from './shared.mjs';
import { VERIFICATION_LIMITS as L } from '../../../repositories/verification.mjs';
import {
  Affiliation,
  AFFILIATION_TYPE,
  EMAIL_CODES,
  EvidenceUpload,
  PublicUsersQuery,
  Reason,
  WorkEmail,
  WorkEmailConfirm,
} from './organisationInput.mjs';

/** Returns `applyStatus`, which the console's decisions go through too. */
export function registerPersonalRoutes(ctx) {
  const {
    addEvidence,
    createClaim,
    emailFailsFor,
    guardianRouter,
    mailer,
    mintToken,
    nextId,
    notifyReviewers,
    openStates,
    orgCanAttest,
    orgOf,
    orgRouter,
    orgVerificationStatus,
    peekToken,
    playerRouter,
    publicProfileForOrg,
    publicProfileForUser,
    reads,
    reviewersOf,
    storeEvidenceFile,
    subjectClaimView,
    transition,
    unit,
    userClaims,
    useToken,
    verEvent,
    verification,
    verifiedDomainsOf,
    verLevelFor,
    vmetric,
  } = ctx;
  orgRouter.get('/verification/me', (req, res) => {
    const claims = userClaims(req.orgUser.id).map(subjectClaimView);
    const [affType] = AFFILIATION_TYPE(req.org);
    const idClaim = claims.find((c) => c.claimType === 'PERSON_IDENTITY');
    const affClaim = claims.find(
      (c) => c.claimType === affType && c.organisation?.id === req.org.id && c.current !== false,
    );
    const emailProved = claims.some((c) => c.evidence.some((e) => e.type === 'official_email'));
    res.json({
      claims,
      verificationLevel: verLevelFor(req.org.id, req.orgUser.id),
      organisationStatus: orgVerificationStatus(req.org),
      steps: [
        // progress persists because it derives from records
        {
          id: 'identity',
          label: 'Verify identity',
          done: idClaim?.status === 'verified',
          state: idClaim?.status ?? 'not_started',
        },
        { id: 'organisation', label: 'Select organisation', done: true, state: 'done' },
        { id: 'role', label: 'Add professional role', done: !!affClaim, state: affClaim ? 'done' : 'not_started' },
        {
          id: 'work_email',
          label: 'Verify work email',
          done: emailProved,
          state: emailProved ? 'done' : 'not_started',
        },
        {
          id: 'confirmation',
          label: 'Organisation confirmation',
          done: affClaim?.status === 'verified',
          state: affClaim?.status ?? 'not_started',
        },
      ],
      publicPreview: publicProfileForUser(req.orgUser.id),
    });
  });

  orgRouter.post('/verification/identity', (req, res) => {
    if (reads.claims.hasOpenIdentity(req.orgUser.id)) {
      return res
        .status(409)
        .json({ error: 'IDENTITY_CLAIM_EXISTS', message: 'An identity verification is already open or complete.' });
    }
    const claim = createClaim(
      {
        subjectType: 'user',
        subjectId: req.orgUser.id,
        claimType: 'PERSON_IDENTITY',
        status: 'collecting_evidence',
        metadata: { declaredName: req.orgUser.name == null ? null : String(req.orgUser.name).slice(0, L.name) },
      },
      req,
    );
    res.status(201).json({
      claim: subjectClaimView(claim),
      note: 'Add an identity document as evidence, then submit. A document is evidence — verification happens in review, never on upload.',
    });
  });

  orgRouter.post('/verification/claims/:id/evidence', (req, res) => {
    const claim = reads.claims.byId(req.params.id);
    if (!claim || claim.subjectId !== req.orgUser.id || claim.subjectType !== 'user') {
      return res.status(404).json({ error: 'CLAIM_NOT_FOUND' }); // concealment: no cross-tenant existence leak
    }
    if (!['unverified', 'collecting_evidence', 'pending'].includes(claim.status)) {
      return res
        .status(409)
        .json({ error: 'CLAIM_NOT_EDITABLE', message: 'Evidence can only be added before review completes.' });
    }
    const body = inputOrRefuse(res, EvidenceUpload, req.body ?? {});
    if (!body) return;
    const { dataUrl, filename } = body;
    const note = filled(body.note);
    let fileFields = {};
    if (dataUrl) {
      const stored = storeEvidenceFile(dataUrl, filename, req);
      if (stored.error) return res.status(422).json({ error: stored.error });
      fileFields = stored;
    } else if (!note) {
      return res.status(400).json({ error: 'EVIDENCE_REQUIRED', message: 'Attach a document or a note.' });
    }
    // A risk signal, not a verdict.
    const dup = fileFields.sha256 && reads.evidence.digestSeen(fileFields.sha256, req.orgUser.id);
    const ev = unit(() => {
      const added = addEvidence(
        {
          type: 'document',
          source: 'subject_upload',
          suppliedByKind: 'org_user',
          suppliedById: req.orgUser.id,
          orgId: req.org.id,
          claimIds: [claim.id],
          ...fileFields,
          meta: { note: note ?? '' },
          visibility: ['PERSON_IDENTITY', 'LICENCE'].includes(claim.claimType)
            ? 'trust_and_safety'
            : 'organisation_internal',
        },
        req,
      );
      if (dup) verification.claims.addRiskFlags(claim.id, { codes: ['DUPLICATE_EVIDENCE_HASH'] });
      if (claim.status === 'unverified') applyStatus(claim, 'collecting_evidence', req);
      return added;
    });
    res.status(201).json({ claim: subjectClaimView(reads.claims.byId(claim.id)), evidenceChecks: ev.checks });
  });
  function applyStatus(claim, to, req, opts = {}, also = {}) {
    return transition(
      claim,
      to,
      {
        actorKind: req.orgUser ? 'org_user' : 'system',
        actorId: req.orgUser?.id,
        actorName: req.orgUser?.name,
        ...opts,
      },
      req,
      also,
    );
  }
  /** Null for anyone else's claim, so its existence does not leak across tenants. */
  const onlyMine = (req, c) => (c && c.subjectId === req.orgUser.id && c.subjectType === 'user' ? c : null);

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

  /** The automated pre-review pipeline; runs inside the caller's unit on a claim just moved to pending. */
  function routeClaim(claimId, req) {
    const claim = reads.claims.byId(claimId);
    const org = claim.organisationId ? orgOf(claim.organisationId) : null;
    const flags = riskFlags({
      email: claim.metadata?.workEmail,
      orgDomains: org ? verifiedDomainsOf(org.id) : [],
      applicantHadRecentRevocation: userClaims(claim.subjectId).some(
        (c) => c.status === 'revoked' && c.revokedAt > Date.now() - 30 * 86_400_000,
      ),
      competingOrgClaims: userClaims(claim.subjectId).filter(
        (c) =>
          c.id !== claim.id &&
          c.claimType === claim.claimType &&
          c.organisationId &&
          c.organisationId !== claim.organisationId &&
          openStates.includes(c.status),
      ).length,
      orgSuspended: !!org?.suspended,
      emailChallengeFails: emailFailsFor(claim.subjectId),
      duplicateEvidenceHash: claim.riskFlags.includes('DUPLICATE_EVIDENCE_HASH'),
    });
    const documentOnly = reads.evidence.byIds(claim.evidenceIds).every((e) => e.type === 'document');
    const { decision, reasons } = decideReview({
      claimType: claim.claimType,
      orgHasActiveAuthority: !!org && orgCanAttest(org) && reviewersOf(org.id).length > 0,
      documentOnly,
      riskFlagCount: flags.length,
      disputed: !!claim.disputedAt,
    });
    const record = { addRiskFlags: flags, reviewReasons: reasons };
    if (decision === 'REQUIRES_HUMAN_REVIEW') {
      applyStatus(claim, 'requires_human_review', req, {}, record);
      vmetric('routedToHumanReview');
    } else {
      applyStatus(claim, 'automated_checks_passed', req, {}, record);
      vmetric('autoPrechecksPassed');
      verEvent(
        'automated_check.passed',
        { claimId: claim.id, subjectId: claim.subjectId, orgId: claim.organisationId, after: { riskFlags: flags } },
        req,
      );
      if (claim.organisationId) {
        notifyReviewers(
          claim.organisationId,
          `${req.orgUser?.name ?? 'A colleague'} asks ${org?.name} to confirm ${claim.claimType === 'CLUB_ROLE' || claim.claimType === 'AGENCY_ROLE' ? `the role “${claim.role}”` : 'their affiliation'}.`,
          claim.id,
        );
      }
    }
  }

  // ----- professional affiliation request (creates the linked pair)
  orgRouter.post('/verification/affiliation', (req, res) => {
    const body = inputOrRefuse(res, Affiliation, req.body ?? {});
    if (!body) return;
    // The account's own role, which no schema has read, may be longer than a claim's.
    const role = body.role != null ? filled(body.role) : (filled(req.orgUser.role)?.slice(0, L.role) ?? null);
    if (!presentOrRefuse(res, role, 'role')) return;
    const startP = isAbsent(body.validFrom) ? null : parseDateOrInstant(body.validFrom, { dayEdge: 'start' });
    const [affType, roleType] = AFFILIATION_TYPE(req.org);
    const existing = userClaims(req.orgUser.id).filter(
      (c) =>
        c.organisationId === req.org.id &&
        [affType, roleType].includes(c.claimType) &&
        c.current !== false &&
        [...openStates, 'verified'].includes(c.status),
    );
    if (existing.length)
      return res.status(409).json({
        error: 'AFFILIATION_CLAIM_EXISTS',
        message: 'A current affiliation request or verification already exists for this organisation.',
      });
    const pairId = nextId('vpair');
    const base = {
      subjectType: 'user',
      subjectId: req.orgUser.id,
      organisationId: req.org.id,
      status: 'collecting_evidence',
      metadata: {
        pairId,
        declaredName: req.orgUser.name == null ? null : String(req.orgUser.name).slice(0, L.name),
        requestedStart: startP ? startP.ms : null,
      },
    };
    const [aff, roleClaim] = unit(() => [
      createClaim({ ...base, claimType: affType }, req),
      createClaim({ ...base, claimType: roleType, role }, req),
    ]);
    res.status(201).json({
      affiliation: subjectClaimView(aff),
      role: subjectClaimView(roleClaim),
      next: 'Prove control of your work email (POST /org/verification/work-email), then the organisation confirms the relationship. Email control alone never equals verified employment.',
    });
  });

  // ----- work-email proof. The code travels only in the e-mail.
  orgRouter.post('/verification/work-email', async (req, res) => {
    const body = inputOrRefuse(res, WorkEmail, req.body ?? {}, EMAIL_CODES);
    if (!body) return;
    const email = body.email.trim().toLowerCase();
    const problem = emailProblem(email);
    if (problem) return res.status(400).json({ error: problem });
    const dom = domainOfEmail(email);
    if (isDisposable(dom))
      return res.status(422).json({
        error: 'DISPOSABLE_EMAIL_REFUSED',
        message: 'Disposable addresses cannot prove a working relationship.',
      });
    if (isFreeMail(dom))
      return res.status(422).json({
        error: 'COMPANY_EMAIL_REQUIRED',
        message:
          'A free-provider address does not evidence organisation email control. If your organisation has no domain, ask the organisation to confirm you directly — or Trust & Safety reviews the case.',
      });
    const secret = unit(() => {
      const minted = mintToken({
        purpose: 'work_email',
        email,
        subjectKind: 'org_user',
        subjectId: req.orgUser.id,
        orgId: req.org.id,
      });
      verEvent('email.challenge_sent', { subjectId: req.orgUser.id, orgId: req.org.id, after: { domain: dom } }, req);
      return minted;
    });
    await mailer.send({
      to: email,
      subject: 'Confirm your work email for ScoutBox verification',
      text: `Hi ${req.orgUser.name},\n\nYour ScoutBox work-email confirmation code is ${secret}\n\nEntering it proves control of this mailbox. It expires in 30 minutes and works once.\n\nIf you did not request this, ignore the email.`,
    });
    res
      .status(201)
      .json({ sent: true, note: 'Enter the code from the mailbox. Codes are single-use and expire in 30 minutes.' });
  });

  orgRouter.post('/verification/work-email/confirm', (req, res) => {
    const body = inputOrRefuse(res, WorkEmailConfirm, req.body ?? {}, EMAIL_CODES);
    if (!body) return;
    const { code, email } = body;
    // The token is consumed only together with the evidence and the claims it proves.
    const peek = peekToken({
      purpose: 'work_email',
      secret: code,
      email: email ?? null,
      subjectId: req.orgUser.id,
    });
    if (peek.error) {
      // A risk signal.
      verification.tokens.recordFailedAttempts(req.orgUser.id, 'work_email');
      vmetric('emailChallengeFailures');
      return res.status(peek.error === 'TOKEN_EXPIRED' ? 410 : 401).json({ error: peek.error });
    }
    if (peek.token.subjectId !== req.orgUser.id) return res.status(403).json({ error: 'TOKEN_WRONG_ACCOUNT' });
    const dom = domainOfEmail(peek.token.email);
    const covered = verifiedDomainsOf(req.org.id).some((d) => domainCovered(dom, d));
    const [affType, roleType] = AFFILIATION_TYPE(req.org);
    const open = userClaims(req.orgUser.id).filter(
      (c) =>
        c.organisationId === req.org.id && [affType, roleType].includes(c.claimType) && openStates.includes(c.status),
    );
    if (!open.length) {
      useToken(peek.token); // a correct code is spent even when there is nothing to attach it to
      return res.status(409).json({
        error: 'NO_OPEN_AFFILIATION',
        message: 'Request an affiliation first — the email proof attaches to it.',
      });
    }
    unit(() => {
      useToken(peek.token);
      addEvidence(
        {
          type: 'official_email',
          source: 'email_challenge',
          suppliedByKind: 'org_user',
          suppliedById: req.orgUser.id,
          orgId: req.org.id,
          claimIds: open.map((c) => c.id),
          visibility: 'organisation_internal',
          meta: { domain: dom, domainCoveredByOrg: covered, addressHash: sha256(peek.token.email) }, // the address itself is not stored on the evidence record
        },
        req,
      );
      for (const c of open) {
        verification.claims.recordWorkEmail(c.id, { workEmail: peek.token.email, domainCoveredByOrg: covered }); // subject+org internal, never public
        verEvent(
          'email.challenge_passed',
          { claimId: c.id, subjectId: req.orgUser.id, orgId: req.org.id, after: { domain: dom, covered } },
          req,
        );
        if (['collecting_evidence', 'unverified'].includes(c.status)) {
          if (c.status === 'unverified') applyStatus(c, 'collecting_evidence', req);
          applyStatus(c, 'pending', req);
          routeClaim(c.id, req);
        }
      }
    });
    res.json({
      domainControl: 'passed',
      domainCoveredByOrg: covered,
      claims: open.map((c) => subjectClaimView(reads.claims.byId(c.id))),
      note: 'Email control recorded as evidence. It does NOT by itself verify employment — an authorised organisation administrator confirms the relationship next.',
    });
  });

  // ----- disputes from the subject
  orgRouter.post('/verification/claims/:id/dispute', (req, res) => {
    const claim = onlyMine(req, reads.claims.byId(req.params.id));
    if (!claim) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    const body = inputOrRefuse(res, Reason, req.body ?? {});
    if (!body) return;
    const reason = filled(body.reason);
    if (!presentOrRefuse(res, reason, 'reason')) return;
    return openDispute(res, claim, { byKind: 'org_user', byId: req.orgUser.id, byName: req.orgUser.name }, reason, req);
  });
  function openDispute(res, claim, by, reason, req) {
    if (reads.disputes.hasOpen(claim.id)) {
      return res.status(409).json({ error: 'DISPUTE_ALREADY_OPEN' });
    }
    const d = unit(() => {
      const created = verification.disputes.create({
        id: nextId('vdsp'),
        claimId: claim.id,
        byKind: by.byKind,
        byId: by.byId,
        byName: by.byName == null ? null : String(by.byName).slice(0, L.name),
        reason: reason.slice(0, L.reason),
        status: 'open',
        resolution: null,
        createdAt: Date.now(),
        resolvedAt: null,
        resolvedBy: null,
        resolvedById: null,
        resolutionAttribution: null,
      });
      if (claim.status === 'verified') applyStatus(claim, 'disputed', req ?? { orgUser: null }, { reason });
      else verification.claims.addReviewReasons(claim.id, { codes: ['DISPUTED_CLAIM'] });
      verEvent('claim.disputed', {
        claimId: claim.id,
        subjectId: claim.subjectId,
        orgId: claim.organisationId,
        reason,
        actorKind: by.byKind,
        actorId: by.byId,
        actorName: by.byName,
      });
      return created;
    });
    vmetric('disputes');
    res.status(201).json({
      dispute: d,
      note: 'The claim is flagged, its history is preserved, and Trust & Safety reviews the dispute. Disputed claims never silently disappear.',
    });
    return null;
  }

  // ============================================== safe public projections
  orgRouter.get('/verification/public/user/:id', (req, res) => res.json(publicProfileForUser(req.params.id)));
  orgRouter.get('/verification/public/org/:id', (req, res) => res.json(publicProfileForOrg(req.params.id)));
  // So list screens make one call, not N.
  orgRouter.get('/verification/public/users', (req, res) => {
    const query = inputOrRefuse(res, PublicUsersQuery, req.query ?? {}, { root: 'query' });
    if (!query) return;
    res.json({ profiles: listedIds(query.ids).map((id) => publicProfileForUser(id)) });
  });
  playerRouter.get('/verification/org/:id', (req, res) => res.json(publicProfileForOrg(req.params.id)));
  guardianRouter.get('/verification/org/:id', (req, res) => res.json(publicProfileForOrg(req.params.id)));

  return { applyStatus };
}
