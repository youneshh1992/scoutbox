// M14 — organisation verification: personal claims, work-email proof, the
// club Verification console, official domains, the verification-admin
// hierarchy (with dual control), squad invitations, conflict declarations and
// coach references.
//
// Authority model (§5): a person can never verify themselves. Employment and
// role facts are confirmed by an AUTHORISED ORGANISATION ADMINISTRATOR of a
// VERIFIED organisation; domain control is evidence of mailbox control, never
// of employment. Where no authority exists, the case routes to Trust & Safety
// as a prepared human-review case — humans are the LAST step, not the first.
import { isAdult, visibleToOrg } from '../domain.mjs';
import { parseDateOrInstant, isAbsent } from '../temporal.mjs';
import {
  emailProblem, domainOfEmail, isFreeMail, isDisposable, normalizeDomain,
  domainCovered, riskFlags, decideReview, evidenceCompleteness, verLevelRank,
  VER_LEVELS, sha256,
} from './shared.mjs';

const AFFILIATION_TYPE = (org) =>
  org.type === 'agency' ? ['AGENCY_AFFILIATION', 'AGENCY_ROLE']
    : org.level === 'grassroots' ? ['GRASSROOTS_AFFILIATION', 'CLUB_ROLE']
      : ['CLUB_AFFILIATION', 'CLUB_ROLE'];

export function registerOrganisationVerification(ctx) {
  const {
    db, app, orgRouter, playerRouter, guardianRouter, nextId, persist, persistNow,
    notify, mailer, idx, verEvent, createClaim, transition, addEvidence,
    storeEvidenceFile, requireVer, vmetric, publicProfileForUser, publicProfileForOrg,
    mintToken, consumeToken, effectiveStatus, orgCanAttest, verLevelFor,
    hasVerLevel, findPlayer, isBlocked, randomHex,
  } = ctx;

  // Orgs created after the M14 migration (self-registration, root approval)
  // may not carry the verification container yet — initialise it lazily for
  // every /org/verification/* route before any handler touches it.
  orgRouter.use('/verification', (req, _res, next) => {
    req.org.verification ??= { domains: [], revokedAt: null, orgType: req.org.type === 'agency' ? 'agency' : (req.org.level === 'grassroots' ? 'grassroots club' : 'professional club') };
    next();
  });

  const openStates = ['unverified', 'collecting_evidence', 'pending', 'automated_checks_passed', 'requires_human_review'];
  const userClaims = (userId) => idx.claimsFor('user', userId);
  const orgOf = (id) => db.orgs.find((o) => o.id === id) ?? null;
  const reviewersOf = (orgId, atLeast = 'verification_reviewer') =>
    db.verAdmins.filter((a) => a.orgId === orgId && a.status === 'active' && verLevelRank(a.level) >= verLevelRank(atLeast))
      .map((a) => db.users.find((u) => u.id === a.userId && !u.removedAt)).filter(Boolean);
  const notifyReviewers = (orgId, text, refId) => {
    for (const u of reviewersOf(orgId)) notify({ kind: 'org_user', id: u.id }, 'verification', text, refId);
  };
  const emailFailsFor = (userId) => db.verTokens.filter((t) => t.subjectId === userId && t.purpose === 'work_email' && (t.attemptsFailed ?? 0) > 0).reduce((n, t) => n + t.attemptsFailed, 0);

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
      evidence: db.verEvidence.filter((e) => claim.evidenceIds.includes(e.id)).map((e) => ({
        id: e.id, type: e.type, receivedAt: e.receivedAt, filename: e.filename,
        checks: e.checks, note: e.meta?.note ?? null,
      })),
      humanReviewNote: claim.status === 'requires_human_review'
        ? humanReviewExplanation(claim) : null,
    };
  };
  function humanReviewExplanation(claim) {
    // §6/§43: the UI must explain WHY, in plain language, without leaking
    // internal security rules.
    const bits = [];
    if (claim.reviewReasons.includes('ROOT_ORGANISATION_BOOTSTRAP')) bits.push('an authorised organisation administrator has not yet been established for this organisation');
    if (claim.reviewReasons.includes('NO_AUTHORITATIVE_SOURCE')) bits.push('no authorised administrator or authoritative registry can confirm this automatically');
    if (claim.reviewReasons.includes('DOCUMENT_AUTHENTICITY_UNCONFIRMED')) bits.push('an uploaded document is evidence, not proof — a reviewer checks it against authoritative sources');
    if (claim.reviewReasons.includes('DISPUTED_CLAIM')) bits.push('the claim is under dispute');
    return `ScoutBox needs to review this request${bits.length ? ` because ${bits.join('; ')}` : ''}.`;
  }

  // ============================================ personal verification (§43)
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
      steps: [ // §43 onboarding — progress persists because it derives from records
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
    if (userClaims(req.orgUser.id).some((c) => c.claimType === 'PERSON_IDENTITY' && [...openStates, 'verified'].includes(c.status))) {
      return res.status(409).json({ error: 'IDENTITY_CLAIM_EXISTS', message: 'An identity verification is already open or complete.' });
    }
    const claim = createClaim({
      subjectType: 'user', subjectId: req.orgUser.id, claimType: 'PERSON_IDENTITY',
      status: 'collecting_evidence', metadata: { declaredName: req.orgUser.name },
    }, req);
    res.status(201).json({ claim: subjectClaimView(claim), note: 'Add an identity document as evidence, then submit. A document is evidence — verification happens in review, never on upload.' });
  });

  orgRouter.post('/verification/claims/:id/evidence', (req, res) => {
    const claim = db.verClaims.find((c) => c.id === req.params.id);
    if (!claim || claim.subjectId !== req.orgUser.id || claim.subjectType !== 'user') {
      return res.status(404).json({ error: 'CLAIM_NOT_FOUND' }); // concealment: no cross-tenant existence leak
    }
    if (!['unverified', 'collecting_evidence', 'pending'].includes(claim.status)) {
      return res.status(409).json({ error: 'CLAIM_NOT_EDITABLE', message: 'Evidence can only be added before review completes.' });
    }
    const { dataUrl, filename, note } = req.body ?? {};
    let fileFields = {};
    if (dataUrl) {
      const stored = storeEvidenceFile(dataUrl, filename, req);
      if (stored.error) return res.status(422).json({ error: stored.error });
      fileFields = stored;
    } else if (!note?.trim()) {
      return res.status(400).json({ error: 'EVIDENCE_REQUIRED', message: 'Attach a document or a note.' });
    }
    // Duplicate-evidence hash detection (risk signal, not a verdict).
    const dup = fileFields.sha256 && db.verEvidence.some((e) => e.sha256 === fileFields.sha256 && e.suppliedById !== req.orgUser.id);
    const ev = addEvidence({
      type: 'document', source: 'subject_upload', suppliedByKind: 'org_user', suppliedById: req.orgUser.id,
      orgId: req.org.id, claimIds: [claim.id], ...fileFields, meta: { note: String(note ?? '').slice(0, 400) },
      visibility: ['PERSON_IDENTITY', 'LICENCE'].includes(claim.claimType) ? 'trust_and_safety' : 'organisation_internal',
    }, req);
    claim.evidenceIds.push(ev.id);
    if (dup && !claim.riskFlags.includes('DUPLICATE_EVIDENCE_HASH')) claim.riskFlags.push('DUPLICATE_EVIDENCE_HASH');
    if (claim.status === 'unverified') applyStatus(claim, 'collecting_evidence', req);
    persist();
    res.status(201).json({ claim: subjectClaimView(claim), evidenceChecks: ev.checks });
  });
  function applyStatus(claim, to, req, opts = {}) {
    return transition(claim, to, { actorKind: 'org_user', actorId: req.orgUser?.id, actorName: req.orgUser?.name, ...opts }, req);
  }

  // Submit → deterministic pre-review pipeline (§25): completeness, dedupe,
  // conflicts, risk flags, decision, routing, packaged case. All automated —
  // the only humans afterwards are the AUTHORITATIVE ones.
  orgRouter.post('/verification/claims/:id/submit', (req, res) => {
    const claim = db.verClaims.find((c) => c.id === req.params.id && c.subjectId === req.orgUser.id && c.subjectType === 'user');
    if (!claim) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    if (!['collecting_evidence', 'unverified'].includes(claim.status)) {
      return res.status(409).json({ error: 'ALREADY_SUBMITTED' });
    }
    const evTypes = db.verEvidence.filter((e) => claim.evidenceIds.includes(e.id)).map((e) => e.type);
    const completeness = evidenceCompleteness(claim.claimType, evTypes);
    if (!completeness.complete) {
      return res.status(422).json({ error: 'EVIDENCE_INCOMPLETE', missing: completeness.missing });
    }
    if (claim.status === 'unverified') applyStatus(claim, 'collecting_evidence', req);
    applyStatus(claim, 'pending', req);
    routeClaim(claim, req);
    persist();
    res.json({ claim: subjectClaimView(claim) });
  });

  function routeClaim(claim, req) {
    const org = claim.organisationId ? orgOf(claim.organisationId) : null;
    const flags = riskFlags({
      email: claim.metadata?.workEmail,
      orgDomains: (org?.verification?.domains ?? []).filter((d) => d.status === 'verified').map((d) => d.domain),
      applicantHadRecentRevocation: userClaims(claim.subjectId).some((c) => c.status === 'revoked' && c.revokedAt > Date.now() - 30 * 86_400_000),
      competingOrgClaims: userClaims(claim.subjectId).filter((c) => c.id !== claim.id && c.claimType === claim.claimType && c.organisationId && c.organisationId !== claim.organisationId && openStates.includes(c.status)).length,
      orgSuspended: !!org?.suspended,
      emailChallengeFails: emailFailsFor(claim.subjectId),
      duplicateEvidenceHash: claim.riskFlags.includes('DUPLICATE_EVIDENCE_HASH'),
    });
    claim.riskFlags = [...new Set([...claim.riskFlags, ...flags])];
    const documentOnly = db.verEvidence.filter((e) => claim.evidenceIds.includes(e.id)).every((e) => e.type === 'document');
    const { decision, reasons } = decideReview({
      claimType: claim.claimType,
      orgHasActiveAuthority: !!org && orgCanAttest(org) && reviewersOf(org.id).length > 0,
      documentOnly, riskFlagCount: flags.length,
      disputed: !!claim.disputedAt,
    });
    claim.reviewReasons = reasons;
    if (decision === 'REQUIRES_HUMAN_REVIEW') {
      applyStatus(claim, 'requires_human_review', req);
      vmetric('routedToHumanReview');
    } else {
      applyStatus(claim, 'automated_checks_passed', req);
      vmetric('autoPrechecksPassed');
      verEvent('automated_check.passed', { claimId: claim.id, subjectId: claim.subjectId, orgId: claim.organisationId, after: { riskFlags: flags } }, req);
      if (claim.organisationId) {
        notifyReviewers(claim.organisationId, `${req.orgUser?.name ?? 'A colleague'} asks ${org?.name} to confirm ${claim.claimType === 'CLUB_ROLE' || claim.claimType === 'AGENCY_ROLE' ? `the role “${claim.role}”` : 'their affiliation'}.`, claim.id);
      }
    }
  }

  // ----- professional affiliation request (creates the linked pair)
  orgRouter.post('/verification/affiliation', (req, res) => {
    const role = String(req.body?.role ?? req.orgUser.role ?? '').trim().slice(0, 60);
    if (!role) return res.status(400).json({ error: 'ROLE_REQUIRED' });
    const [affType, roleType] = AFFILIATION_TYPE(req.org);
    const existing = userClaims(req.orgUser.id).filter((c) => c.organisationId === req.org.id && [affType, roleType].includes(c.claimType) && c.current !== false && [...openStates, 'verified'].includes(c.status));
    if (existing.length) return res.status(409).json({ error: 'AFFILIATION_CLAIM_EXISTS', message: 'A current affiliation request or verification already exists for this organisation.' });
    const pairId = nextId('vpair');
    const base = {
      subjectType: 'user', subjectId: req.orgUser.id, organisationId: req.org.id,
      status: 'collecting_evidence', metadata: { pairId, declaredName: req.orgUser.name, requestedStart: req.body?.validFrom ?? null },
    };
    const aff = createClaim({ ...base, claimType: affType }, req);
    const roleClaim = createClaim({ ...base, claimType: roleType, role }, req);
    res.status(201).json({
      affiliation: subjectClaimView(aff), role: subjectClaimView(roleClaim),
      next: 'Prove control of your work email (POST /org/verification/work-email), then the organisation confirms the relationship. Email control alone never equals verified employment.',
    });
  });

  // ----- work-email proof (§7). One-time token; failure counting; the code
  // travels ONLY in the email (local fake transport in this environment).
  orgRouter.post('/verification/work-email', async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
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
    persistNow();
    res.status(201).json({ sent: true, note: 'Enter the code from the mailbox. Codes are single-use and expire in 30 minutes.' });
  });

  orgRouter.post('/verification/work-email/confirm', (req, res) => {
    const { code, email } = req.body ?? {};
    const out = consumeToken({ purpose: 'work_email', secret: code, email: email ?? null, subjectId: req.orgUser.id });
    if (out.error) {
      // count failures against open tokens for this user (risk signal)
      for (const t of db.verTokens) if (t.subjectId === req.orgUser.id && t.purpose === 'work_email' && !t.usedAt) t.attemptsFailed = (t.attemptsFailed ?? 0) + 1;
      vmetric('emailChallengeFailures');
      persist();
      return res.status(out.error === 'TOKEN_EXPIRED' ? 410 : 401).json({ error: out.error });
    }
    if (out.token.subjectId !== req.orgUser.id) return res.status(403).json({ error: 'TOKEN_WRONG_ACCOUNT' });
    const dom = domainOfEmail(out.token.email);
    const covered = (req.org.verification?.domains ?? []).some((d) => d.status === 'verified' && domainCovered(dom, d.domain));
    const [affType, roleType] = AFFILIATION_TYPE(req.org);
    const open = userClaims(req.orgUser.id).filter((c) => c.organisationId === req.org.id && [affType, roleType].includes(c.claimType) && openStates.includes(c.status));
    if (!open.length) return res.status(409).json({ error: 'NO_OPEN_AFFILIATION', message: 'Request an affiliation first — the email proof attaches to it.' });
    const ev = addEvidence({
      type: 'official_email', source: 'email_challenge', suppliedByKind: 'org_user', suppliedById: req.orgUser.id,
      orgId: req.org.id, claimIds: open.map((c) => c.id), visibility: 'organisation_internal',
      meta: { domain: dom, domainCoveredByOrg: covered, addressHash: sha256(out.token.email) }, // the address itself is not stored on the evidence record
    }, req);
    for (const c of open) {
      c.evidenceIds.push(ev.id);
      c.metadata.workEmail = out.token.email; // subject+org internal, never public
      c.metadata.domainControl = 'passed';
      c.metadata.domainCoveredByOrg = covered;
      verEvent('email.challenge_passed', { claimId: c.id, subjectId: req.orgUser.id, orgId: req.org.id, after: { domain: dom, covered } }, req);
      if (['collecting_evidence', 'unverified'].includes(c.status)) {
        if (c.status === 'unverified') applyStatus(c, 'collecting_evidence', req);
        applyStatus(c, 'pending', req);
        routeClaim(c, req);
      }
    }
    persist();
    res.json({
      domainControl: 'passed', domainCoveredByOrg: covered,
      claims: open.map(subjectClaimView),
      note: 'Email control recorded as evidence. It does NOT by itself verify employment — an authorised organisation administrator confirms the relationship next.',
    });
  });

  // ----- disputes from the subject (§16)
  orgRouter.post('/verification/claims/:id/dispute', (req, res) => {
    const claim = db.verClaims.find((c) => c.id === req.params.id && c.subjectId === req.orgUser.id && c.subjectType === 'user');
    if (!claim) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'REASON_REQUIRED' });
    return openDispute(res, claim, { byKind: 'org_user', byId: req.orgUser.id, byName: req.orgUser.name }, reason, req);
  });
  function openDispute(res, claim, by, reason, req) {
    if (db.verDisputes.some((d) => d.claimId === claim.id && d.status === 'open')) {
      return res.status(409).json({ error: 'DISPUTE_ALREADY_OPEN' });
    }
    const d = {
      id: nextId('vdsp'), claimId: claim.id, ...by, reason: reason.slice(0, 600),
      status: 'open', resolution: null, createdAt: Date.now(), resolvedAt: null, resolvedBy: null,
    };
    db.verDisputes.push(d);
    if (claim.status === 'verified') applyStatus(claim, 'disputed', req ?? { orgUser: null }, { reason });
    else if (!claim.reviewReasons.includes('DISPUTED_CLAIM')) claim.reviewReasons.push('DISPUTED_CLAIM');
    verEvent('claim.disputed', { claimId: claim.id, subjectId: claim.subjectId, orgId: claim.organisationId, reason, actorKind: by.byKind, actorId: by.byId, actorName: by.byName });
    vmetric('disputes');
    persistNow();
    res.status(201).json({ dispute: d, note: 'The claim is flagged, its history is preserved, and Trust & Safety reviews the dispute. Disputed claims never silently disappear.' });
    return null;
  }
  ctx.openDispute = openDispute;

  // ============================================== safe public projections
  orgRouter.get('/verification/public/user/:id', (req, res) => res.json(publicProfileForUser(req.params.id)));
  orgRouter.get('/verification/public/org/:id', (req, res) => res.json(publicProfileForOrg(req.params.id)));
  // Batch endpoint so list screens do ONE call, not N (§69).
  orgRouter.get('/verification/public/users', (req, res) => {
    const ids = String(req.query.ids ?? '').split(',').filter(Boolean).slice(0, 100);
    res.json({ profiles: ids.map((id) => publicProfileForUser(id)) });
  });
  playerRouter.get('/verification/org/:id', (req, res) => res.json(publicProfileForOrg(req.params.id)));
  guardianRouter.get('/verification/org/:id', (req, res) => res.json(publicProfileForOrg(req.params.id)));

  // ================================================== console: dashboard
  orgRouter.get('/verification/dashboard', (req, res) => {
    if (!requireVer(req, res, 'verification_viewer')) return;
    const mine = db.verClaims.filter((c) => c.organisationId === req.org.id && c.subjectType === 'user');
    const now = Date.now();
    // "Currently verified" derives from the EFFECTIVE engine (M14.1): a raw
    // status of 'verified' does not count when org standing, account removal
    // or expiry suppresses it at read time.
    const effCurrent = (c) => {
      const u = db.users.find((x) => x.id === c.subjectId);
      return effectiveStatus(c, { org: req.org, subjectRemoved: !u || !!u.removedAt, now }).current;
    };
    res.json({
      organisationStatus: ctx.orgVerificationStatus(req.org),
      counts: {
        verifiedStaff: new Set(mine.filter(effCurrent).map((c) => c.subjectId)).size,
        pending: mine.filter((c) => ['pending', 'automated_checks_passed'].includes(c.status)).length,
        humanReview: mine.filter((c) => c.status === 'requires_human_review').length,
        expiringSoon: mine.filter((c) => c.status === 'verified' && c.validUntil && c.validUntil > now && c.validUntil < now + 30 * 86_400_000).length,
        disputed: db.verDisputes.filter((d) => d.status === 'open' && mine.some((c) => c.id === d.claimId)).length,
        revoked: mine.filter((c) => c.status === 'revoked').length,
        domains: (req.org.verification?.domains ?? []).length,
        administrators: db.verAdmins.filter((a) => a.orgId === req.org.id && a.status === 'active').length,
      },
    });
  });

  // Prepared request rows (§8): identity state, email/domain status, risk
  // flags and history — the admin decides on a PACKAGED case.
  const requestRow = (claim) => {
    const user = db.users.find((u) => u.id === claim.subjectId);
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
    const rows = db.verClaims
      .filter((c) => c.organisationId === req.org.id && c.subjectType === 'user' && ['pending', 'automated_checks_passed'].includes(c.status))
      .map(requestRow);
    res.json({ items: rows, note: 'Decisions are audited. You cannot decide your own request.' });
  });

  // The confirmation decision (§7): confirm / correct role / correct dates /
  // mark former / reject / request more information.
  orgRouter.post('/verification/requests/:claimId/decide', (req, res) => {
    if (!requireVer(req, res, 'verification_reviewer')) return;
    const claim = db.verClaims.find((c) => c.id === req.params.claimId && c.organisationId === req.org.id && c.subjectType === 'user');
    if (!claim) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    // §27 self-verification prohibition — server-side, always, with an event.
    if (claim.subjectId === req.orgUser.id) {
      verEvent('security.self_verification_blocked', { claimId: claim.id, subjectId: claim.subjectId, orgId: req.org.id, reason: 'reviewer attempted to decide own claim' }, req);
      persistNow();
      return res.status(403).json({ error: 'SELF_VERIFICATION_FORBIDDEN', message: 'You cannot be the authoritative confirmer of your own claim. Another authorised administrator must decide it.' });
    }
    if (!['pending', 'automated_checks_passed'].includes(claim.status)) {
      return res.status(409).json({ error: 'CLAIM_NOT_DECIDABLE', message: `The request is ${claim.status} — it may already be decided, withdrawn or escalated.` });
    }
    // A suspended / unverified / revoked organisation cannot attest (§29).
    if (!orgCanAttest(req.org)) {
      return res.status(403).json({ error: 'ORG_NOT_ELIGIBLE', message: `This organisation is ${ctx.orgVerificationStatus(req.org)} and cannot confirm staff verification right now.` });
    }
    const { action, role, validFrom, validUntil, reason } = req.body ?? {};
    const pair = db.verClaims.filter((c) => c.metadata?.pairId && c.metadata.pairId === claim.metadata?.pairId && ['pending', 'automated_checks_passed'].includes(c.status));
    const targets = pair.length ? pair : [claim];
    const decide = (to, extra = {}) => {
      for (const c of targets) {
        const err = applyStatus(c, to, req, { method: 'organisation_admin_confirmation', reason, eventType: to === 'verified' ? 'review.approved' : 'review.rejected' });
        if (err) return err;
        Object.assign(c, extra);
        if (to === 'verified') {
          c.authorityType = 'org_admin';
          c.authorityId = req.orgUser.id;
          idx.registerAuthority(c);
        }
      }
      return null;
    };
    if (action === 'confirm' || action === 'correct_role' || action === 'mark_former') {
      const roleClaim = targets.find((c) => /ROLE/.test(c.claimType));
      if (action === 'correct_role') {
        if (!role?.trim()) return res.status(400).json({ error: 'ROLE_REQUIRED' });
        if (roleClaim) {
          verEvent('claim.corrected', { claimId: roleClaim.id, subjectId: claim.subjectId, orgId: req.org.id, before: { role: roleClaim.role }, after: { role: String(role).trim() } }, req);
          roleClaim.role = String(role).trim().slice(0, 60);
        }
      }
      // M23 P5.7 (T-3): the period bounds are instants or calendar days that
      // exist. `Number(x) || null` used to read a typo as "no end".
      const fromP = isAbsent(validFrom) ? null : parseDateOrInstant(validFrom, { dayEdge: 'start' });
      if (fromP && !fromP.ok) return res.status(400).json({ error: 'DATE_INVALID', field: 'validFrom', message: `validFrom is a calendar day (YYYY-MM-DD) or an instant (${fromP.why}).`, expected: fromP.expected });
      const untilP = isAbsent(validUntil) ? null : parseDateOrInstant(validUntil, { dayEdge: 'end' });
      if (untilP && !untilP.ok) return res.status(400).json({ error: 'DATE_INVALID', field: 'validUntil', message: `validUntil is a calendar day (YYYY-MM-DD) or an instant (${untilP.why}).`, expected: untilP.expected });
      const from = fromP ? fromP.ms : Date.now();
      const until = untilP ? untilP.ms : (action === 'mark_former' ? Date.now() : null);
      // Ordering is checked only when the club STATED both ends; a defaulted start is "now" by convention, not a claim.
      if (fromP && untilP && !(from < until)) return res.status(400).json({ error: 'INTERVAL_INVALID', field: 'validUntil', message: 'The period must end after it starts.' });
      const err = decide('verified', { validFrom: from, validUntil: until, current: action !== 'mark_former' });
      if (err) return res.status(409).json({ error: err });
      notify({ kind: 'org_user', id: claim.subjectId }, 'verification', `${req.org.name} confirmed your ${action === 'mark_former' ? 'historical ' : ''}affiliation${roleClaim ? ` as ${roleClaim.role}` : ''}. ✓`, claim.id);
    } else if (action === 'reject') {
      if (!reason?.trim()) return res.status(400).json({ error: 'REASON_REQUIRED', message: 'A rejection needs a reason — it is shown to the person and audited.' });
      const err = decide('rejected');
      if (err) return res.status(409).json({ error: err });
      notify({ kind: 'org_user', id: claim.subjectId }, 'verification', `${req.org.name} declined the verification request: ${String(reason).slice(0, 140)}`, claim.id);
    } else if (action === 'request_info') {
      for (const c of targets) applyStatus(c, 'collecting_evidence', req, { reason });
      notify({ kind: 'org_user', id: claim.subjectId }, 'verification', `${req.org.name} asks for more information on your verification request${reason ? `: ${String(reason).slice(0, 140)}` : ''}.`, claim.id);
    } else {
      return res.status(400).json({ error: 'ACTION_UNKNOWN', message: 'Use confirm, correct_role, mark_former, reject or request_info.' });
    }
    ctx.ledgerAppend?.({ type: 'verification_decision', orgId: req.org.id, scoutName: req.orgUser.name, playerId: null, detail: { claimId: claim.id, action } });
    persistNow();
    res.json({ decided: action, claims: targets.map(subjectClaimView) });
  });

  // ----- staff registry with filters (§8)
  orgRouter.get('/verification/staff', (req, res) => {
    if (!requireVer(req, res, 'verification_viewer')) return;
    const { state, current, method, role } = req.query;
    let rows = db.verClaims.filter((c) => c.organisationId === req.org.id && c.subjectType === 'user' && !['unverified'].includes(c.status));
    if (state) rows = rows.filter((c) => c.status === state);
    if (current === 'true') rows = rows.filter((c) => c.current !== false);
    if (current === 'false') rows = rows.filter((c) => c.current === false);
    if (method) rows = rows.filter((c) => c.verificationMethod === method);
    if (role) rows = rows.filter((c) => (c.role ?? '').toLowerCase().includes(String(role).toLowerCase()));
    res.json({
      items: rows.map((c) => {
        const u = db.users.find((x) => x.id === c.subjectId);
        const eff = effectiveStatus(c, { org: req.org });
        return {
          claimId: c.id, person: { id: u?.id, name: u?.name }, claimType: c.claimType, role: c.role,
          status: c.status, effective: eff, current: c.current, validFrom: c.validFrom, validUntil: c.validUntil,
          verificationMethod: c.verificationMethod, verifiedAt: c.verifiedAt,
        };
      }),
    });
  });

  // ----- employment change (§37): close the period, keep the truth.
  orgRouter.post('/verification/staff/:userId/departed', (req, res) => {
    if (!requireVer(req, res, 'verification_reviewer')) return;
    if (req.params.userId === req.orgUser.id) return res.status(403).json({ error: 'SELF_VERIFICATION_FORBIDDEN', message: 'Ask another administrator to record your own departure.' });
    const claims = db.verClaims.filter((c) => c.organisationId === req.org.id && c.subjectId === req.params.userId && c.subjectType === 'user' && c.status === 'verified' && c.current !== false);
    if (!claims.length) return res.status(404).json({ error: 'NO_CURRENT_VERIFIED_CLAIMS' });
    const untilP = isAbsent(req.body?.validUntil) ? null : parseDateOrInstant(req.body.validUntil, { dayEdge: 'end' });
    if (untilP && !untilP.ok) return res.status(400).json({ error: 'DATE_INVALID', field: 'validUntil', message: `validUntil is a calendar day (YYYY-MM-DD) or an instant (${untilP.why}).`, expected: untilP.expected });
    const until = untilP ? untilP.ms : Date.now();
    for (const c of claims) {
      verEvent('claim.corrected', { claimId: c.id, subjectId: c.subjectId, orgId: req.org.id, before: { current: true }, after: { current: false, validUntil: until }, reason: 'marked departed' }, req);
      c.current = false;            // history is NOT erased — the verified period closes
      c.validUntil = c.validUntil ?? until;
      c.updatedAt = Date.now();
    }
    // Powers tied to the relationship end immediately.
    for (const a of db.verAdmins.filter((x) => x.orgId === req.org.id && x.userId === req.params.userId && x.status === 'active')) {
      a.status = 'revoked'; a.revokedAt = Date.now(); a.revokedBy = req.orgUser.id;
      verEvent('admin.revoked', { orgId: req.org.id, subjectId: a.userId, reason: 'departed' }, req);
    }
    notify({ kind: 'org_user', id: req.params.userId }, 'verification', `${req.org.name} recorded you as departed. Your verified history stays on your profile; if this is wrong you can dispute it from Verification.`, claims[0].id);
    persistNow();
    res.json({ closed: claims.length, note: 'Current badges end now; the historical verified period remains. The person can dispute this.' });
  });

  // ================================================ official domains (§8)
  orgRouter.get('/verification/domains', (req, res) => {
    if (!requireVer(req, res, 'verification_viewer')) return;
    res.json({
      domains: req.org.verification?.domains ?? [],
      requests: db.verDomainRequests.filter((r) => r.orgId === req.org.id),
    });
  });

  orgRouter.post('/verification/domains', async (req, res) => {
    if (!requireVer(req, res, 'verification_admin')) return;
    const domain = normalizeDomain(req.body?.domain);
    const challengeEmail = String(req.body?.challengeEmail ?? '').trim().toLowerCase();
    if (!domain || !domain.includes('.')) return res.status(400).json({ error: 'DOMAIN_INVALID' });
    if (isFreeMail(domain) || isDisposable(domain)) return res.status(422).json({ error: 'SHARED_PROVIDER_DOMAIN', message: 'Free/shared email providers cannot be organisation domains.' });
    if ((req.org.verification.domains ?? []).some((d) => d.domain === domain)) return res.status(409).json({ error: 'DOMAIN_EXISTS' });
    const otherOrg = db.orgs.find((o) => o.id !== req.org.id && (o.verification?.domains ?? []).some((d) => d.domain === domain && d.status === 'verified'));
    const verifiedRoot = (req.org.verification.domains ?? []).find((d) => d.status === 'verified' && domainCovered(domain, d.domain));
    const highRisk = !verifiedRoot || !!otherOrg; // first/root domain or contested → human review
    const r = {
      id: nextId('vdom'), orgId: req.org.id, domain, requestedBy: req.orgUser.id,
      status: highRisk ? 'requires_human_review' : 'email_challenge',
      reviewReasons: [...(otherOrg ? ['DOMAIN_OWNERSHIP_AMBIGUOUS'] : []), ...(!verifiedRoot ? ['HIGH_RISK_ADMIN_CHANGE'] : [])],
      method: null, createdAt: Date.now(), decidedAt: null, decidedBy: null,
    };
    db.verDomainRequests.push(r);
    verEvent('organisation.domain_added', { orgId: req.org.id, after: { domain, status: r.status } }, req);
    if (r.status === 'email_challenge') {
      const problem = emailProblem(challengeEmail);
      if (problem || domainOfEmail(challengeEmail) !== domain) {
        r.status = 'requires_human_review';
        r.reviewReasons.push('DOMAIN_OWNERSHIP_AMBIGUOUS');
      } else {
        const secret = mintToken({ purpose: 'domain_email', email: challengeEmail, orgId: req.org.id, refId: r.id });
        await mailer.send({ to: challengeEmail, subject: `Confirm ${domain} for ${req.org.name} on ScoutBox`, text: `Confirmation code for adding ${domain} as an official ${req.org.name} domain: ${secret}\n\nSingle use, expires in 30 minutes.` });
      }
    }
    persistNow();
    res.status(201).json({
      request: r,
      note: r.status === 'requires_human_review'
        ? 'Root or contested domain changes are reviewed by Trust & Safety before they take effect.'
        : 'A confirmation code went to the mailbox on that domain.',
    });
  });

  orgRouter.post('/verification/domains/:id/confirm', (req, res) => {
    if (!requireVer(req, res, 'verification_admin')) return;
    const r = db.verDomainRequests.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!r) return res.status(404).json({ error: 'DOMAIN_REQUEST_NOT_FOUND' });
    if (r.status !== 'email_challenge') return res.status(409).json({ error: 'NOT_IN_EMAIL_CHALLENGE' });
    const out = consumeToken({ purpose: 'domain_email', secret: req.body?.code });
    if (out.error || out.token.refId !== r.id) {
      vmetric('emailChallengeFailures');
      return res.status(401).json({ error: out.error ?? 'TOKEN_WRONG_PURPOSE' });
    }
    r.status = 'verified'; r.method = 'official_domain_email'; r.decidedAt = Date.now();
    req.org.verification.domains.push({ domain: r.domain, status: 'verified', method: 'official_domain_email', verifiedAt: Date.now(), addedBy: req.orgUser.id });
    createClaim({
      subjectType: 'org', subjectId: req.org.id, claimType: 'ORGANISATION_DOMAIN', organisationId: req.org.id,
      status: 'verified', verificationMethod: 'official_domain_email', verifiedAt: Date.now(),
      verifiedBy: { kind: 'org_admin', id: req.orgUser.id }, metadata: { domain: r.domain },
    }, req);
    verEvent('organisation.domain_verified', { orgId: req.org.id, after: { domain: r.domain } }, req);
    persistNow();
    res.json({ domain: r.domain, status: 'verified' });
  });

  orgRouter.post('/verification/domains/:id/remove', (req, res) => {
    const list = req.org.verification?.domains ?? [];
    const d = list.find((x) => x.domain === normalizeDomain(req.params.id) || x.domain === req.params.id);
    if (!d) return res.status(404).json({ error: 'DOMAIN_NOT_FOUND' });
    const isRoot = !list.some((o) => o !== d && d.domain.endsWith(`.${o.domain}`));
    if (!requireVer(req, res, isRoot ? 'verification_root_admin' : 'verification_admin', { root: isRoot })) return;
    req.org.verification.domains = list.filter((x) => x !== d);
    verEvent('organisation.domain_removed', { orgId: req.org.id, before: { domain: d.domain } }, req);
    persistNow();
    res.json({ removed: d.domain });
  });

  // ======================================== verification administrators (§9)
  orgRouter.get('/verification/admins', (req, res) => {
    if (!requireVer(req, res, 'verification_viewer')) return;
    res.json({
      items: db.verAdmins.filter((a) => a.orgId === req.org.id).map((a) => ({
        ...a, person: { id: a.userId, name: db.users.find((u) => u.id === a.userId)?.name ?? '(removed)' },
      })),
      transfers: db.verRootTransfers?.filter((t) => t.orgId === req.org.id) ?? [],
    });
  });

  orgRouter.post('/verification/admins', (req, res) => {
    const { userId, level } = req.body ?? {};
    if (!VER_LEVELS.includes(level)) return res.status(400).json({ error: 'LEVEL_UNKNOWN' });
    const needsRoot = ['verification_admin', 'verification_root_admin'].includes(level);
    if (!requireVer(req, res, needsRoot ? 'verification_root_admin' : 'verification_admin', { root: needsRoot })) return;
    if (userId === req.orgUser.id) {
      verEvent('security.self_verification_blocked', { orgId: req.org.id, subjectId: userId, reason: 'self-promotion attempt' }, req);
      persistNow();
      return res.status(403).json({ error: 'SELF_PROMOTION_FORBIDDEN', message: 'You cannot change your own verification authority.' });
    }
    const target = db.users.find((u) => u.id === userId && u.orgId === req.org.id && !u.removedAt);
    if (!target) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    if (level === 'verification_root_admin') {
      // §28 dual control: a second root admin (or Trust & Safety) must approve.
      if (db.verRootTransfers.some((t) => t.orgId === req.org.id && t.status === 'pending')) {
        return res.status(409).json({ error: 'TRANSFER_ALREADY_PENDING' });
      }
      const t = { id: nextId('vrtx'), orgId: req.org.id, toUserId: userId, proposedBy: req.orgUser.id, status: 'pending', createdAt: Date.now(), approvedBy: null, approvedAt: null };
      db.verRootTransfers.push(t);
      verEvent('admin.invited', { orgId: req.org.id, subjectId: userId, after: { level, dualControl: 'pending' } }, req);
      persistNow();
      return res.status(202).json({ transfer: t, note: 'Root authority changes need a second approval: another root administrator, or Trust & Safety.' });
    }
    if (db.verAdmins.some((a) => a.orgId === req.org.id && a.userId === userId && a.status === 'active' && a.level === level)) {
      return res.status(409).json({ error: 'ALREADY_GRANTED' });
    }
    const a = { id: nextId('vadm'), orgId: req.org.id, userId, level, status: 'active', invitedBy: req.orgUser.id, createdAt: Date.now(), acceptedAt: Date.now(), revokedAt: null, revokedBy: null };
    db.verAdmins.push(a);
    verEvent('admin.accepted', { orgId: req.org.id, subjectId: userId, after: { level } }, req);
    notify({ kind: 'org_user', id: userId }, 'verification', `You now hold ${level.replace(/_/g, ' ')} authority for ${req.org.name}.`, a.id);
    persistNow();
    res.status(201).json({ admin: a });
  });

  orgRouter.post('/verification/root-transfers/:id/approve', (req, res) => {
    if (!requireVer(req, res, 'verification_root_admin', { root: true })) return;
    const t = (db.verRootTransfers ?? []).find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!t) return res.status(404).json({ error: 'TRANSFER_NOT_FOUND' });
    if (t.status !== 'pending') return res.status(409).json({ error: 'TRANSFER_NOT_PENDING' });
    if (t.proposedBy === req.orgUser.id) {
      return res.status(403).json({ error: 'DUAL_CONTROL_REQUIRED', message: 'The approver must be a different root administrator than the proposer.' });
    }
    if (t.toUserId === req.orgUser.id) {
      return res.status(403).json({ error: 'SELF_PROMOTION_FORBIDDEN', message: 'The beneficiary cannot approve their own root authority.' });
    }
    t.status = 'approved'; t.approvedBy = req.orgUser.id; t.approvedAt = Date.now();
    const a = { id: nextId('vadm'), orgId: req.org.id, userId: t.toUserId, level: 'verification_root_admin', status: 'active', invitedBy: t.proposedBy, createdAt: Date.now(), acceptedAt: Date.now(), revokedAt: null, revokedBy: null };
    db.verAdmins.push(a);
    verEvent('admin.accepted', { orgId: req.org.id, subjectId: t.toUserId, after: { level: 'verification_root_admin', dualControl: `approved by ${req.orgUser.id}` } }, req);
    persistNow();
    res.json({ transfer: t, admin: a });
  });

  orgRouter.post('/verification/admins/:id/revoke', (req, res) => {
    const a = db.verAdmins.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!a) return res.status(404).json({ error: 'ADMIN_NOT_FOUND' });
    const isRootRow = a.level === 'verification_root_admin';
    if (!requireVer(req, res, isRootRow ? 'verification_root_admin' : 'verification_admin', { root: isRootRow })) return;
    if (a.userId === req.orgUser.id) return res.status(403).json({ error: 'SELF_REVOKE_FORBIDDEN', message: 'Another administrator (or Trust & Safety) must change your authority.' });
    if (a.status !== 'active') return res.status(409).json({ error: 'ALREADY_REVOKED' });
    if (isRootRow) {
      const roots = db.verAdmins.filter((x) => x.orgId === req.org.id && x.level === 'verification_root_admin' && x.status === 'active');
      if (roots.length <= 1) {
        return res.status(409).json({ error: 'LAST_ROOT_ADMIN', message: 'An organisation cannot remove its final root administrator itself — Trust & Safety handles root recovery so the organisation is never orphaned.' });
      }
    }
    a.status = 'revoked'; a.revokedAt = Date.now(); a.revokedBy = req.orgUser.id;
    verEvent('admin.revoked', { orgId: req.org.id, subjectId: a.userId, reason: String(req.body?.reason ?? 'revoked by organisation') }, req);
    persistNow();
    res.json({ admin: a, note: 'Authority ends immediately. Claims this person previously approved keep their provenance and can be reviewed (Trust & Safety cascade tools).' });
  });

  // ========================================== conflict declarations (§17)
  orgRouter.post('/verification/conflicts', (req, res) => {
    const { kind, subject, note } = req.body ?? {};
    const KINDS = ['family_relationship', 'agent_relationship', 'financial_interest', 'coaching_relationship', 'other'];
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'KIND_UNKNOWN', kinds: KINDS });
    const c = { id: nextId('vcoi'), userId: req.orgUser.id, orgId: req.org.id, kind, subject: String(subject ?? '').slice(0, 120), note: String(note ?? '').slice(0, 400), createdAt: Date.now(), withdrawnAt: null };
    db.verConflicts.push(c);
    persistNow();
    res.status(201).json({ conflict: c, note: 'Declarations are explicit and visible to your organisation’s verification administrators and Trust & Safety — never inferred, never public.' });
  });
  orgRouter.get('/verification/conflicts', (req, res) => {
    const admin = hasVerLevel(req.org.id, req.orgUser.id, 'verification_reviewer');
    res.json({ items: db.verConflicts.filter((c) => c.orgId === req.org.id && (admin || c.userId === req.orgUser.id)) });
  });
  orgRouter.post('/verification/conflicts/:id/withdraw', (req, res) => {
    const c = db.verConflicts.find((x) => x.id === req.params.id && x.orgId === req.org.id && x.userId === req.orgUser.id);
    if (!c) return res.status(404).json({ error: 'CONFLICT_NOT_FOUND' });
    c.withdrawnAt = Date.now();
    persistNow();
    res.json({ conflict: c });
  });

  // ============================================== squad invitations (§20)
  const INVITES_PER_DAY = 20;
  orgRouter.post('/verification/player-invites', async (req, res) => {
    if (!orgCanAttest(req.org)) return res.status(403).json({ error: 'ORG_NOT_ELIGIBLE', message: 'Only a verified organisation can send squad invitations.' });
    const today = db.verPlayerInvites.filter((i) => i.orgId === req.org.id && i.createdAt > Date.now() - 86_400_000).length;
    if (today >= INVITES_PER_DAY) return res.status(429).json({ error: 'INVITE_RATE_LIMIT', message: `Deterministic limit: ${INVITES_PER_DAY} invitations per organisation per day.` });
    const { name, email, squad, playerId } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: 'NAME_REQUIRED' });
    if (email && emailProblem(email)) return res.status(400).json({ error: 'EMAIL_SYNTAX' });
    // M14.1 recipient binding: when the invite targets an EXISTING ScoutBox
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
    const inv = {
      id: nextId('vpin'), orgId: req.org.id, byUserId: req.orgUser.id, byName: req.orgUser.name,
      name: String(name).trim().slice(0, 80), squad: String(squad ?? '').slice(0, 60),
      status: 'pending', playerId: null, targetPlayerId: targetPlayer?.id ?? null, guardianApproved: null,
      createdAt: Date.now(), expiresAt: Date.now() + 14 * 86_400_000, acceptedAt: null,
    };
    db.verPlayerInvites.push(inv);
    const secret = mintToken({
      purpose: 'player_invite', email: email ?? null, orgId: req.org.id, refId: inv.id,
      subjectKind: targetPlayer ? 'player' : null, subjectId: targetPlayer?.id ?? null,
      ttlMs: 14 * 86_400_000,
    });
    if (email) await mailer.send({ to: email, subject: `${req.org.name} invited you to ScoutBox`, text: `Hi ${inv.name},\n\n${req.orgUser.name} at ${req.org.name} invites you to join ScoutBox${inv.squad ? ` (${inv.squad})` : ''}.\n\nInvitation code: ${secret}\n\nJoining is your choice — an invitation gives the club no control over your profile. Under-18s join through a parent or guardian.` });
    persistNow();
    res.status(201).json({ invite: inv, ...(email ? {} : { code: secret, note: 'No email supplied — hand the single-use code to the player (or their guardian) directly.' }) });
  });
  orgRouter.get('/verification/player-invites', (req, res) => {
    res.json({ items: db.verPlayerInvites.filter((i) => i.orgId === req.org.id) });
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
    const child = db.players.find((p) => p.id === req.body?.childId && req.guardian.childIds.includes(p.id));
    if (!child) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    return acceptInvite(res, req.body?.code, child, req.guardian);
  });
  function acceptInvite(res, code, player, guardian, claimedEmail = null) {
    // M14.1 recipient binding: peek first, run EVERY binding check, and only
    // then consume — a wrong-recipient attempt must never burn the rightful
    // recipient's single-use secret.
    const out = ctx.peekToken({ purpose: 'player_invite', secret: code });
    if (out.error) return res.status(out.error === 'TOKEN_EXPIRED' ? 410 : 404).json({ error: out.error });
    const inv = db.verPlayerInvites.find((i) => i.id === out.token.refId && i.status === 'pending' && !i.playerId);
    if (!inv) return res.status(404).json({ error: 'INVITE_NOT_FOUND' });
    const org = orgOf(inv.orgId);
    if (!org || org.suspended) return res.status(403).json({ error: 'ORG_UNAVAILABLE' });
    // 1. Identity-targeted invite: only the named player (adult flow) or that
    //    exact child through their EXISTING guardian relationship may accept.
    if (out.token.subjectId && out.token.subjectId !== player.id) {
      verEvent('security.self_verification_blocked', { orgId: inv.orgId, subjectId: player.id, reason: 'invite recipient mismatch (identity-bound)', after: { invite: inv.id } });
      persist();
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
    out.token.usedAt = Date.now(); // all binding checks passed — consume now
    inv.status = 'accepted'; inv.playerId = player.id; inv.acceptedAt = Date.now();
    inv.guardianApproved = guardian ? { guardianId: guardian.id, at: Date.now() } : null;
    verEvent('claim.created', { orgId: inv.orgId, subjectId: player.id, after: { invite: inv.id, guardianApproved: !!guardian } });
    notify({ kind: 'org_user', id: inv.byUserId }, 'verification', `${player.name} accepted your squad invitation${guardian ? ' (guardian-approved)' : ''}.`, inv.id);
    persistNow();
    return res.json({ invite: inv, note: 'Joining links nothing else: club visibility, contact and consent all still follow the standing safeguarding rules.' });
  }

  // ================================================ coach references (§18)
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
    if (!relationship?.trim() || !summary?.trim()) return res.status(400).json({ error: 'FIELDS_REQUIRED', message: 'relationship and summary are required.' });
    const ref = {
      id: nextId('vref'), version: 1, supersedesId: null, playerId: p.id, playerName: p.name,
      coachUserId: req.orgUser.id, coachName: req.orgUser.name, orgId: req.org.id, orgName: req.org.name,
      roleAtTime: roleClaim.role ?? req.orgUser.role,
      provenanceSnapshot: { // §18: snapshot at submission — later changes never rewrite it
        claimId: roleClaim.id, claimType: roleClaim.claimType, status: 'verified',
        method: roleClaim.verificationMethod, verifiedAt: roleClaim.verifiedAt, snapshotAt: Date.now(),
      },
      relationship: String(relationship).slice(0, 80), capacity: String(capacity ?? '').slice(0, 120),
      fromYear: Number(fromYear) || null, toYear: Number(toYear) || null,
      structured: { strengths: String(strengths ?? '').slice(0, 500), development: String(development ?? '').slice(0, 500), summary: String(summary).slice(0, 800) },
      status: 'active', withdrawnAt: null, withdrawReason: null, createdAt: Date.now(),
    };
    db.verReferences.push(ref);
    verEvent('claim.created', { orgId: req.org.id, subjectId: p.id, after: { reference: ref.id, provenance: ref.provenanceSnapshot.claimId } }, req);
    // Guardian routing for minors — existing DOB/country logic, untouched.
    if (isAdult(p)) notify({ kind: 'player', id: p.id }, 'verification', `${req.orgUser.name} (${req.org.name}) added a structured reference to your profile.`, ref.id);
    else if (p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'verification', `${req.orgUser.name} (verified at ${req.org.name}) added a structured reference for ${p.name}. You can review it in the app.`, ref.id);
    persistNow();
    res.status(201).json({ reference: ref });
  });

  orgRouter.get('/verification/references', (req, res) => {
    res.json({ items: db.verReferences.filter((r) => r.orgId === req.org.id) });
  });

  orgRouter.post('/verification/references/:id/withdraw', (req, res) => {
    const ref = db.verReferences.find((r) => r.id === req.params.id && r.orgId === req.org.id && r.coachUserId === req.orgUser.id);
    if (!ref) return res.status(404).json({ error: 'REFERENCE_NOT_FOUND' });
    if (ref.status !== 'active') return res.status(409).json({ error: 'NOT_ACTIVE' });
    if (!req.body?.reason?.trim()) return res.status(400).json({ error: 'REASON_REQUIRED' });
    ref.status = 'withdrawn'; ref.withdrawnAt = Date.now(); ref.withdrawReason = String(req.body.reason).slice(0, 300);
    verEvent('claim.corrected', { orgId: req.org.id, subjectId: ref.playerId, before: { reference: ref.id, status: 'active' }, after: { status: 'withdrawn' }, reason: ref.withdrawReason }, req);
    persistNow();
    res.json({ reference: ref, note: 'Withdrawal is an event — the original text and its provenance remain in the record.' });
  });

  orgRouter.post('/verification/references/:id/correct', (req, res) => {
    const old = db.verReferences.find((r) => r.id === req.params.id && r.orgId === req.org.id && r.coachUserId === req.orgUser.id);
    if (!old) return res.status(404).json({ error: 'REFERENCE_NOT_FOUND' });
    if (old.status !== 'active') return res.status(409).json({ error: 'NOT_ACTIVE' });
    const next = {
      ...structuredClone(old), id: nextId('vref'), version: old.version + 1, supersedesId: old.id,
      structured: {
        strengths: String(req.body?.strengths ?? old.structured.strengths).slice(0, 500),
        development: String(req.body?.development ?? old.structured.development).slice(0, 500),
        summary: String(req.body?.summary ?? old.structured.summary).slice(0, 800),
      },
      createdAt: Date.now(),
    };
    old.status = 'superseded';
    db.verReferences.push(next);
    verEvent('claim.corrected', { orgId: req.org.id, subjectId: old.playerId, before: { reference: old.id }, after: { reference: next.id, version: next.version } }, req);
    persistNow();
    res.json({ reference: next, superseded: old.id, note: 'Corrections create a new version — the original is never silently edited.' });
  });

  // Player/guardian read their references, with honest provenance wording.
  const refPlayerView = (r) => ({
    id: r.id, version: r.version, coachName: r.coachName, orgName: r.orgName, roleAtTime: r.roleAtTime,
    relationship: r.relationship, capacity: r.capacity, fromYear: r.fromYear, toYear: r.toYear,
    structured: r.structured, status: r.status, createdAt: r.createdAt,
    provenance: (() => {
      const claim = db.verClaims.find((c) => c.id === r.provenanceSnapshot.claimId);
      const stillCurrent = claim && effectiveStatus(claim, { org: orgOf(r.orgId) }).current;
      return stillCurrent
        ? `Coach's ${r.orgName} affiliation is verified.`
        : 'Coach affiliation was verified when this reference was submitted.';
    })(),
  });
  playerRouter.get('/references', (req, res) => {
    res.json({ items: db.verReferences.filter((r) => r.playerId === req.player.id && r.status !== 'superseded').map(refPlayerView) });
  });
  guardianRouter.get('/children/:id/references', (req, res) => {
    if (!req.guardian.childIds.includes(req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    res.json({ items: db.verReferences.filter((r) => r.playerId === req.params.id && r.status !== 'superseded').map(refPlayerView) });
  });

  // ====================================== root organisation bootstrap (§6)
  // Public application — deterministic checks first, humans last. The
  // applicant gets a single-use applicant secret binding follow-up calls.
  app.post('/auth/org/verification/apply', async (req, res) => {
    const b = req.body ?? {};
    const required = ['orgName', 'orgType', 'country', 'website', 'applicantName', 'applicantRole', 'workEmail'];
    const missing = required.filter((k) => !String(b[k] ?? '').trim());
    if (missing.length) return res.status(400).json({ error: 'FIELDS_REQUIRED', missing });
    const ORG_TYPES = ['professional club', 'academy', 'grassroots club', 'federation/association', 'agency', 'other approved football organisation'];
    if (!ORG_TYPES.includes(b.orgType)) return res.status(400).json({ error: 'ORG_TYPE_UNKNOWN', types: ORG_TYPES });
    const problem = emailProblem(b.workEmail);
    if (problem) return res.status(400).json({ error: problem });
    const domain = normalizeDomain(b.domain || b.website);
    const emailDom = domainOfEmail(b.workEmail);
    // ---- deterministic automated checks (§6). No network fetch happens here:
    // DNS/https probing from this environment is not implemented — recorded
    // honestly as not_configured rather than pretended.
    const dupOrg = db.orgs.find((o) => o.name.trim().toLowerCase() === String(b.orgName).trim().toLowerCase());
    const dupDomainOrg = db.orgs.find((o) => (o.verification?.domains ?? []).some((d) => d.status === 'verified' && d.domain === domain));
    const dupRequest = db.verRootRequests.find((r) => ['pending', 'requires_human_review', 'collecting_evidence'].includes(r.status)
      && (normalizeDomain(r.domain) === domain || r.orgName.trim().toLowerCase() === String(b.orgName).trim().toLowerCase()));
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
    const r = {
      id: nextId('vroot'), status: 'collecting_evidence',
      orgName: String(b.orgName).trim().slice(0, 120), orgType: b.orgType, country: String(b.country).slice(0, 40),
      federation: String(b.federation ?? '').slice(0, 80) || null, website: String(b.website).slice(0, 200),
      domain, applicantName: String(b.applicantName).trim().slice(0, 80), applicantRole: String(b.applicantRole).slice(0, 60),
      workEmail: String(b.workEmail).toLowerCase(), officialContact: String(b.officialContact ?? '').slice(0, 200) || null,
      declarations: b.declarations ?? null, evidenceIds: [], checks, riskFlags: flags,
      reviewReasons: [], emailProved: false, existingOrgId: dupOrg?.id ?? null,
      applicantSecretHash: sha256(applicantSecret),
      createdAt: Date.now(), decidedAt: null, decidedBy: null, decisionReason: null,
      resultOrgId: null, resultUserId: null,
    };
    db.verRootRequests.push(r);
    const secret = mintToken({ purpose: 'root_email', email: r.workEmail, refId: r.id });
    await mailer.send({ to: r.workEmail, subject: `Verify your email for the ${r.orgName} ScoutBox application`, text: `Your ScoutBox organisation-application code is ${secret}\n\nSingle use, expires in 30 minutes.` });
    verEvent('review.requested', { orgId: null, subjectId: null, after: { rootRequest: r.id, checks } });
    persistNow();
    res.status(201).json({
      requestId: r.id, applicantSecret, checks,
      note: 'Confirm the emailed code, add supporting evidence, then submit. Domain/email control is evidence of mailbox control — it does not by itself verify the organisation.',
    });
  });

  const rootReqBySecret = (req, res) => {
    const r = db.verRootRequests.find((x) => x.id === req.params.id);
    if (!r || r.applicantSecretHash !== sha256(String(req.body?.applicantSecret ?? req.query?.applicantSecret ?? ''))) {
      res.status(404).json({ error: 'REQUEST_NOT_FOUND' }); // concealment — no probing which ids exist
      return null;
    }
    return r;
  };

  app.post('/auth/org/verification/apply/:id/confirm-email', (req, res) => {
    const r = rootReqBySecret(req, res); if (!r) return;
    const out = consumeToken({ purpose: 'root_email', secret: req.body?.code, email: r.workEmail });
    if (out.error || out.token.refId !== r.id) {
      vmetric('emailChallengeFailures');
      return res.status(401).json({ error: out.error ?? 'TOKEN_WRONG_PURPOSE' });
    }
    r.emailProved = true;
    r.checks.evidenceCompleteness = 'email_proved';
    verEvent('email.challenge_passed', { after: { rootRequest: r.id } });
    persistNow();
    res.json({ emailProved: true });
  });

  app.post('/auth/org/verification/apply/:id/evidence', (req, res) => {
    const r = rootReqBySecret(req, res); if (!r) return;
    if (!['collecting_evidence', 'requires_human_review'].includes(r.status)) return res.status(409).json({ error: 'REQUEST_CLOSED' });
    const { dataUrl, filename, note } = req.body ?? {};
    let fileFields = {};
    if (dataUrl) {
      const stored = storeEvidenceFile(dataUrl, filename, req);
      if (stored.error) return res.status(422).json({ error: stored.error });
      fileFields = stored;
    } else if (!note?.trim()) return res.status(400).json({ error: 'EVIDENCE_REQUIRED' });
    const dup = fileFields.sha256 && db.verEvidence.some((e) => e.sha256 === fileFields.sha256);
    const ev = addEvidence({
      type: 'document', source: 'root_application', suppliedByKind: 'applicant', suppliedById: r.id,
      orgId: null, claimIds: [], ...fileFields, meta: { note: String(note ?? '').slice(0, 400), rootRequest: r.id },
      visibility: 'trust_and_safety',
    });
    r.evidenceIds.push(ev.id);
    if (dup && !r.riskFlags.includes('DUPLICATE_EVIDENCE_HASH')) r.riskFlags.push('DUPLICATE_EVIDENCE_HASH');
    persistNow();
    res.status(201).json({ evidence: { id: ev.id, checks: ev.checks } });
  });

  app.post('/auth/org/verification/apply/:id/submit', (req, res) => {
    const r = rootReqBySecret(req, res); if (!r) return;
    if (r.status !== 'collecting_evidence') return res.status(409).json({ error: 'ALREADY_SUBMITTED' });
    if (!r.emailProved) return res.status(422).json({ error: 'EMAIL_NOT_PROVED', message: 'Confirm the emailed code first.' });
    // §6/§24: a first administrator with no existing ScoutBox authority is
    // ALWAYS a human decision. Everything else was prepared automatically.
    const { reasons } = decideReview({
      claimType: 'ORGANISATION_IDENTITY', isFirstOrgAdmin: true,
      duplicateOrg: r.checks.duplicateOrganisation === 'flagged' || r.checks.domainAlreadyVerifiedElsewhere === 'flagged',
      domainAmbiguous: r.checks.emailDomainAlignment === 'mismatch',
      riskFlagCount: r.riskFlags.length,
    });
    r.reviewReasons = reasons;
    r.status = 'requires_human_review';
    vmetric('routedToHumanReview');
    verEvent('review.requested', { after: { rootRequest: r.id, reasons } });
    persistNow();
    res.json({
      status: r.status, reasons,
      explanation: `ScoutBox has confirmed control of a ${domainOfEmail(r.workEmail)} mailbox, but an authorised organisation administrator has not yet been established — Trust & Safety reviews the application and the evidence before the first administrator is appointed.`,
    });
  });

  app.get('/auth/org/verification/apply/:id/status', (req, res) => {
    const r = db.verRootRequests.find((x) => x.id === req.params.id);
    if (!r || r.applicantSecretHash !== sha256(String(req.query.applicantSecret ?? ''))) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
    res.json({ id: r.id, status: r.status, checks: r.checks, reviewReasons: r.reviewReasons, decisionReason: r.decisionReason, resultOrgId: r.resultOrgId });
  });
}
