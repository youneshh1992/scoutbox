import { filled, inputOrRefuse } from '../../platform/schemas.mjs';
import {
  emailProblem,
  domainOfEmail,
  isFreeMail,
  isDisposable,
  normalizeDomain,
  domainCovered,
  riskFlags,
  decideReview,
  sha256,
} from './shared.mjs';
import {
  Application,
  APPLICATION_CODES,
  APPLICATION_REQUIRED,
  ApplicationEmailConfirm,
  ApplicationEvidence,
  ApplicationStatusQuery,
  ApplicationSubmit,
} from './organisationInput.mjs';

export function registerApplicationRoutes(ctx) {
  const {
    addEvidence,
    app,
    mailer,
    mintToken,
    nextId,
    orgs,
    peekToken,
    randomHex,
    reads,
    storeEvidenceFile,
    unit,
    useToken,
    verEvent,
    verification,
    vmetric,
  } = ctx;
  // A public application. The applicant secret binds the follow-up calls.
  app.post('/auth/org/verification/apply', async (req, res) => {
    const b = inputOrRefuse(res, Application, req.body ?? {}, APPLICATION_CODES);
    if (!b) return;
    const missing = APPLICATION_REQUIRED.filter((k) => !filled(b[k]));
    if (missing.length) return res.status(400).json({ error: 'FIELDS_REQUIRED', missing, problem: 'required' });
    const decl = b.declarations;
    const problem = emailProblem(b.workEmail);
    if (problem) return res.status(400).json({ error: problem, field: 'workEmail' });
    const domain = normalizeDomain(b.domain || b.website);
    const emailDom = domainOfEmail(b.workEmail);
    // ---- automated checks. DNS and https probing are not implemented, so they are recorded as not_configured.
    const dupOrg = orgs.byName(b.orgName);
    const dupDomainOrg = domain ? reads.domains.verifiedElsewhere(domain) : null;
    const dupRequest = reads.rootRequests.openDuplicate(domain, b.orgName.trim().toLowerCase());
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
        id: nextId('vroot'),
        status: 'collecting_evidence',
        orgName: b.orgName.trim(),
        orgType: b.orgType,
        country: b.country,
        federation: b.federation || null,
        website: b.website,
        domain,
        applicantName: b.applicantName.trim(),
        applicantRole: b.applicantRole.trim(),
        workEmail: b.workEmail.toLowerCase(),
        officialContact: b.officialContact || null,
        declarations: decl ? { authorised: decl.authorised } : null,
        checks,
        riskFlags: flags,
        reviewReasons: [],
        emailProved: false,
        existingOrgId: dupOrg?.id ?? null,
        applicantSecretHash: sha256(applicantSecret),
        createdAt: Date.now(),
        decidedAt: null,
        decidedBy: null,
        decidedById: null,
        decisionAttribution: null,
        decisionReason: null,
        resultOrgId: null,
        resultUserId: null,
        identityLink: null,
      });
      secret = mintToken({ purpose: 'root_email', email: created.workEmail, refId: created.id });
      verEvent('review.requested', { orgId: null, subjectId: null, after: { rootRequest: created.id, checks } });
      return created;
    });
    await mailer.send({
      to: r.workEmail,
      subject: `Verify your email for the ${r.orgName} ScoutBox application`,
      text: `Your ScoutBox organisation-application code is ${secret}\n\nSingle use, expires in 30 minutes.`,
    });
    res.status(201).json({
      requestId: r.id,
      applicantSecret,
      checks,
      note: 'Confirm the emailed code, add supporting evidence, then submit. Domain/email control is evidence of mailbox control — it does not by itself verify the organisation.',
    });
  });

  /** The secret travels in the body, or in the query string of an older client. */
  const rootReqBySecret = (req, res, bodySecret) => {
    const r = reads.rootRequests.byId(req.params.id);
    const querySecret = typeof req.query?.applicantSecret === 'string' ? req.query.applicantSecret : '';
    if (!r || r.applicantSecretHash !== sha256(bodySecret ?? querySecret)) {
      res.status(404).json({ error: 'REQUEST_NOT_FOUND' }); // concealment — no probing which ids exist
      return null;
    }
    return r;
  };

  app.post('/auth/org/verification/apply/:id/confirm-email', (req, res) => {
    const body = inputOrRefuse(res, ApplicationEmailConfirm, req.body ?? {});
    if (!body) return;
    const r = rootReqBySecret(req, res, body.applicantSecret);
    if (!r) return;
    const peek = peekToken({ purpose: 'root_email', secret: body.code, email: r.workEmail });
    if (peek.error || peek.token.refId !== r.id) {
      if (!peek.error) useToken(peek.token);
      vmetric('emailChallengeFailures');
      return res.status(401).json({ error: peek.error ?? 'TOKEN_WRONG_PURPOSE' });
    }
    unit(() => {
      useToken(peek.token);
      verification.rootRequests.proveEmail(r.id);
      verEvent('email.challenge_passed', { after: { rootRequest: r.id } });
    });
    res.json({ emailProved: true });
  });

  app.post('/auth/org/verification/apply/:id/evidence', (req, res) => {
    const body = inputOrRefuse(res, ApplicationEvidence, req.body ?? {});
    if (!body) return;
    const r = rootReqBySecret(req, res, body.applicantSecret);
    if (!r) return;
    if (!['collecting_evidence', 'requires_human_review'].includes(r.status))
      return res.status(409).json({ error: 'REQUEST_CLOSED' });
    const { dataUrl, filename } = body;
    const note = filled(body.note);
    let fileFields = {};
    if (dataUrl) {
      const stored = storeEvidenceFile(dataUrl, filename, req);
      if (stored.error) return res.status(422).json({ error: stored.error });
      fileFields = stored;
    } else if (!note) return res.status(400).json({ error: 'EVIDENCE_REQUIRED' });
    const dup = fileFields.sha256 && reads.evidence.digestSeen(fileFields.sha256);
    const ev = unit(() => {
      const added = addEvidence({
        type: 'document',
        source: 'root_application',
        suppliedByKind: 'applicant',
        suppliedById: r.id,
        orgId: null,
        claimIds: [],
        ...fileFields,
        meta: { note: note ?? '', rootRequest: r.id },
        visibility: 'trust_and_safety',
      });
      if (dup) verification.rootRequests.addRiskFlags(r.id, { codes: ['DUPLICATE_EVIDENCE_HASH'] });
      return added;
    });
    res.status(201).json({ evidence: { id: ev.id, checks: ev.checks } });
  });

  app.post('/auth/org/verification/apply/:id/submit', (req, res) => {
    const body = inputOrRefuse(res, ApplicationSubmit, req.body ?? {});
    if (!body) return;
    const r = rootReqBySecret(req, res, body.applicantSecret);
    if (!r) return;
    if (r.status !== 'collecting_evidence') return res.status(409).json({ error: 'ALREADY_SUBMITTED' });
    if (!r.emailProved)
      return res.status(422).json({ error: 'EMAIL_NOT_PROVED', message: 'Confirm the emailed code first.' });
    // A first administrator with no existing ScoutBox authority is always a human decision.
    const { reasons } = decideReview({
      claimType: 'ORGANISATION_IDENTITY',
      isFirstOrgAdmin: true,
      duplicateOrg:
        r.checks.duplicateOrganisation === 'flagged' || r.checks.domainAlreadyVerifiedElsewhere === 'flagged',
      domainAmbiguous: r.checks.emailDomainAlignment === 'mismatch',
      riskFlagCount: r.riskFlags.length,
    });
    unit(() => {
      verification.rootRequests.submitForReview(r.id, { reviewReasons: reasons });
      verEvent('review.requested', { after: { rootRequest: r.id, reasons } });
    });
    vmetric('routedToHumanReview');
    res.json({
      status: 'requires_human_review',
      reasons,
      explanation: `ScoutBox has confirmed control of a ${domainOfEmail(r.workEmail)} mailbox, but an authorised organisation administrator has not yet been established — Trust & Safety reviews the application and the evidence before the first administrator is appointed.`,
    });
  });

  app.get('/auth/org/verification/apply/:id/status', (req, res) => {
    const query = inputOrRefuse(res, ApplicationStatusQuery, req.query ?? {}, { root: 'query' });
    if (!query) return;
    const r = reads.rootRequests.byId(req.params.id);
    if (!r || r.applicantSecretHash !== sha256(query.applicantSecret ?? ''))
      return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
    res.json({
      id: r.id,
      status: r.status,
      checks: r.checks,
      reviewReasons: r.reviewReasons,
      decisionReason: r.decisionReason,
      resultOrgId: r.resultOrgId,
    });
  });
}
