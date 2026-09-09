// M14 — Trust & Safety review, licence verification, disputes, cascades and
// the deterministic expiry sweep.
//
// Honesty contract:
//  * A human reviewer is the LAST step: every case arrives packaged with the
//    automated checks, evidence, prior claims and the exact reason codes that
//    forced human review.
//  * Licence "verification" is only claimed when an authoritative source
//    confirmed it. Uploaded documents show "Credential submitted"; a manual
//    T&S document review is labelled as exactly that. No production
//    governing-body registry is connected — providers ship `not_configured`,
//    and only a LOCAL TEST fixture (env-gated) exercises the adapter.
//  * Revocation/suspension propagates to effective badges immediately via the
//    read-time engine; history is never deleted.
import { decideReview, normalizeDomain, domainOfEmail, domainCovered, sha256 } from './shared.mjs';

// ---------------------------------------------------------------- registry
// Licence-registry adapter (§13/§63). Interface every future FA/UEFA/
// federation integration implements. Nothing here fakes a network call.
export function licenceProviders() {
  const testState = process.env.TEST_LICENCE_REGISTRY; // '1' | 'down' | unset
  return [
    { id: 'fa-england', name: 'The FA coaching qualifications register', state: 'not_configured' },
    { id: 'uefa', name: 'UEFA coaching licence register', state: 'not_configured' },
    { id: 'local-test-registry', name: 'Local test registry (fixture — test environments only)',
      state: testState === '1' ? 'configured' : testState === 'down' ? 'temporarily_unavailable' : 'not_configured' },
  ];
}
// Deterministic local fixture: exercises exact-match, ambiguous and no-match
// paths in tests. It exists ONLY when TEST_LICENCE_REGISTRY=1.
const TEST_REGISTRY_ROWS = [
  { identifier: 'UEFA-A-12345', holderName: 'diane okafor', licenceType: 'UEFA A Licence', issuer: 'local-test-registry', validUntil: '2028-06-30' },
  { identifier: 'UEFA-B-77777', holderName: 'sam cole', licenceType: 'UEFA B Licence', issuer: 'local-test-registry', validUntil: '2027-01-31' },
  { identifier: 'AMBIG-001', holderName: 'alex taylor', licenceType: 'UEFA B Licence', issuer: 'local-test-registry', validUntil: '2027-01-31' },
  { identifier: 'AMBIG-001', holderName: 'alexis taylor', licenceType: 'UEFA B Licence', issuer: 'local-test-registry', validUntil: '2026-01-31' },
];
export function lookupCredential({ providerId, identifier, holderName }) {
  const provider = licenceProviders().find((p) => p.id === providerId);
  if (!provider) return { state: 'unsupported', result: null };
  if (provider.state !== 'configured') return { state: provider.state, result: null };
  const rows = TEST_REGISTRY_ROWS.filter((r) => r.identifier === String(identifier ?? '').trim());
  if (!rows.length) return { state: 'configured', result: 'no_match' };
  const nameMatches = rows.filter((r) => r.holderName === String(holderName ?? '').trim().toLowerCase());
  if (nameMatches.length === 1 && rows.length === 1) return { state: 'configured', result: 'match', record: nameMatches[0] };
  return { state: 'configured', result: 'ambiguous', candidates: rows.length };
}

export function registerVerificationReview(ctx) {
  const {
    db, orgRouter, adminRouter, nextId, persist, persistNow, notify, idx,
    verEvent, createClaim, transition, addEvidence, storeEvidenceFile,
    effectiveStatus, vmetric, requireVer, hasVerLevel,
  } = ctx;

  const orgOf = (id) => db.orgs.find((o) => o.id === id) ?? null;
  const claimById = (id) => db.verClaims.find((c) => c.id === id);
  const adminTransition = (claim, to, req, opts = {}) =>
    transition(claim, to, { actorKind: 'trust_safety', actorId: 'admin', actorName: 'Trust & Safety', ...opts }, req);

  // ============================================================ licences
  orgRouter.get('/verification/licence-providers', (_req, res) => {
    res.json({
      providers: licenceProviders(),
      note: 'No production governing-body register is connected. Providers listed not_configured are real integration points, not working integrations.',
    });
  });

  orgRouter.post('/verification/licence', (req, res) => {
    const { licenceType, issuer, identifier, issueDate, expiry, dataUrl, filename, holderName } = req.body ?? {};
    if (!licenceType?.trim() || !issuer?.trim()) return res.status(400).json({ error: 'FIELDS_REQUIRED', message: 'licenceType and issuer are required.' });
    const claim = createClaim({
      subjectType: 'user', subjectId: req.orgUser.id, claimType: 'LICENCE',
      organisationId: null, status: 'collecting_evidence', verificationMethod: 'document_submitted',
      validUntil: expiry ? Date.parse(expiry) || null : null,
      metadata: {
        licenceType: String(licenceType).slice(0, 80), issuer: String(issuer).slice(0, 80),
        identifier: String(identifier ?? '').slice(0, 60) || null,
        holderName: String(holderName ?? req.orgUser.name).slice(0, 80),
        issueDate: issueDate ?? null, expiry: expiry ?? null,
        display: 'Credential submitted — verification pending', // §13: never "Licence verified" from an upload
      },
    }, req);
    if (dataUrl) {
      const stored = storeEvidenceFile(dataUrl, filename, req);
      if (stored.error) return res.status(422).json({ error: stored.error });
      const ev = addEvidence({
        type: 'document', source: 'subject_upload', suppliedByKind: 'org_user', suppliedById: req.orgUser.id,
        orgId: req.org.id, claimIds: [claim.id], ...stored, visibility: 'trust_and_safety',
      }, req);
      claim.evidenceIds.push(ev.id);
    }
    persistNow();
    res.status(201).json({
      claim: { id: claim.id, status: claim.status, display: claim.metadata.display },
      note: 'An uploaded credential is a document, not a verified licence. Submit it to run the registry check (where a register is configured) or route it to review.',
    });
  });

  orgRouter.post('/verification/licence/:id/submit', (req, res) => {
    const claim = db.verClaims.find((c) => c.id === req.params.id && c.subjectId === req.orgUser.id && c.claimType === 'LICENCE');
    if (!claim) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    if (!['collecting_evidence', 'pending'].includes(claim.status)) return res.status(409).json({ error: 'ALREADY_SUBMITTED' });
    if (claim.status === 'collecting_evidence') {
      const err = transition(claim, 'pending', { actorKind: 'org_user', actorId: req.orgUser.id }, req);
      if (err) return res.status(409).json({ error: err });
    }
    const providerId = String(req.body?.providerId ?? 'local-test-registry');
    const lookup = lookupCredential({ providerId, identifier: claim.metadata.identifier, holderName: String(claim.metadata.holderName ?? '').toLowerCase() });
    verEvent(lookup.result ? 'automated_check.passed' : 'automated_check.failed', { claimId: claim.id, subjectId: claim.subjectId, after: { provider: providerId, state: lookup.state, result: lookup.result } }, req);
    if (lookup.state !== 'configured') {
      // Fail HONEST (§62): unavailable/unconfigured providers leave the claim
      // pending — never "verified", never "rejected".
      claim.metadata.registry = { provider: providerId, state: lookup.state, checkedAt: Date.now() };
      const routed = transition(claim, 'requires_human_review', { actorKind: 'system', reason: 'no authoritative register available' }, req);
      claim.reviewReasons = [...new Set([...claim.reviewReasons, 'NO_AUTHORITATIVE_SOURCE', 'DOCUMENT_AUTHENTICITY_UNCONFIRMED'])];
      vmetric('routedToHumanReview');
      persistNow();
      return res.json({
        claim: { id: claim.id, status: claim.status, display: claim.metadata.display },
        provider: { id: providerId, state: lookup.state },
        note: lookup.state === 'temporarily_unavailable'
          ? 'Verification provider unavailable — verification remains pending.'
          : 'No authoritative register is configured for this issuer — a reviewer can perform a document review, which is labelled as a document review.',
        routed: routed ? null : 'requires_human_review',
      });
    }
    if (lookup.result === 'match') {
      const rec = lookup.record;
      const ev = addEvidence({
        type: 'registry_result', source: providerId, suppliedByKind: 'system', suppliedById: null,
        orgId: req.org.id, claimIds: [claim.id], visibility: 'trust_and_safety',
        meta: { identifier: rec.identifier, licenceType: rec.licenceType, validUntil: rec.validUntil },
      }, req);
      claim.evidenceIds.push(ev.id);
      claim.validUntil = Date.parse(rec.validUntil) || claim.validUntil;
      claim.metadata.display = `Licence verified: ${rec.licenceType}`;
      claim.metadata.registry = { provider: providerId, result: 'match', checkedAt: Date.now(), reference: rec.identifier };
      transition(claim, 'automated_checks_passed', { actorKind: 'system' }, req);
      const err = transition(claim, 'verified', { actorKind: 'system', method: 'authoritative_registry', eventType: 'claim.verified' }, req);
      if (err) return res.status(409).json({ error: err });
      persistNow();
      return res.json({ claim: { id: claim.id, status: claim.status, display: claim.metadata.display }, provider: { id: providerId, result: 'match' } });
    }
    if (lookup.result === 'ambiguous') {
      claim.reviewReasons = [...new Set([...claim.reviewReasons, 'REGISTRY_AMBIGUOUS_MATCH'])];
      transition(claim, 'requires_human_review', { actorKind: 'system', reason: 'registry returned an ambiguous match' }, req);
      vmetric('routedToHumanReview');
      persistNow();
      return res.json({ claim: { id: claim.id, status: claim.status, display: claim.metadata.display }, provider: { id: providerId, result: 'ambiguous' }, note: 'The register returned more than one plausible record — a human resolves ambiguity, never a guess.' });
    }
    // no_match: absence of a record VERIFIES NOTHING and PROVES NOTHING.
    claim.metadata.registry = { provider: providerId, result: 'no_match', checkedAt: Date.now() };
    transition(claim, 'requires_human_review', { actorKind: 'system', reason: 'registry found no matching record' }, req);
    claim.reviewReasons = [...new Set([...claim.reviewReasons, 'DOCUMENT_AUTHENTICITY_UNCONFIRMED'])];
    vmetric('routedToHumanReview');
    persistNow();
    res.json({ claim: { id: claim.id, status: claim.status, display: claim.metadata.display }, provider: { id: providerId, result: 'no_match' }, note: 'No register record matched. The credential stays unverified; a reviewer can examine the evidence.' });
  });

  // ================================================= evidence access (§38)
  // T&S: everything, every read logged. Org reviewers: organisation_internal
  // evidence of their OWN org only. Subjects: their own uploads' metadata via
  // the subject claim view (organisations.mjs). Nothing is ever public.
  adminRouter.get('/verification/evidence/:id', (req, res) => {
    const ev = db.verEvidence.find((e) => e.id === req.params.id);
    if (!ev) return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    verEvent('evidence.accessed', { claimId: ev.claimIds[0] ?? null, subjectId: ev.suppliedById, orgId: ev.orgId, after: { evidenceId: ev.id, by: 'trust_safety' } });
    persist();
    const blob = ev.mediaId ? ctx.storage.read(ev.mediaId) : null;
    res.json({ evidence: ev, file: blob ? { mime: blob.contentType, base64: blob.buffer.toString('base64') } : null });
  });
  orgRouter.get('/verification/evidence/:id', (req, res) => {
    const ev = db.verEvidence.find((e) => e.id === req.params.id);
    // Concealment: wrong org / wrong visibility looks identical to missing.
    if (!ev || ev.orgId !== req.org.id || ev.visibility !== 'organisation_internal') {
      return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    }
    if (!requireVer(req, res, 'verification_reviewer')) return;
    verEvent('evidence.accessed', { subjectId: ev.suppliedById, orgId: ev.orgId, after: { evidenceId: ev.id, by: req.orgUser.id } }, req);
    persist();
    res.json({ evidence: { ...ev, mediaId: undefined } });
  });

  // ==================================================== T&S review queue
  adminRouter.get('/verification/queue', (req, res) => {
    const now = Date.now();
    const { orgId, country, claimType, status } = req.query;
    let claims = db.verClaims.filter((c) => ['requires_human_review', 'disputed', 'suspended'].includes(c.status));
    if (orgId) claims = claims.filter((c) => c.organisationId === orgId);
    if (claimType) claims = claims.filter((c) => c.claimType === claimType);
    if (status) claims = claims.filter((c) => c.status === status);
    let roots = db.verRootRequests.filter((r) => ['requires_human_review', 'collecting_evidence'].includes(r.status));
    if (country) roots = roots.filter((r) => r.country === country);
    const queueAges = claims.filter((c) => c.status === 'requires_human_review').map((c) => now - c.updatedAt);
    res.json({
      humanReview: claims.filter((c) => c.status === 'requires_human_review').map(adminClaimRow),
      rootRequests: roots.map((r) => ({ ...r, applicantSecretHash: undefined })),
      disputes: db.verDisputes.filter((d) => d.status === 'open'),
      suspended: claims.filter((c) => c.status === 'suspended').map(adminClaimRow),
      disputedClaims: claims.filter((c) => c.status === 'disputed').map(adminClaimRow),
      domainRequests: db.verDomainRequests.filter((r) => r.status === 'requires_human_review'),
      expiring: db.verClaims.filter((c) => c.status === 'verified' && c.validUntil && c.validUntil > now && c.validUntil < now + 30 * 86_400_000).map(adminClaimRow),
      recentlyRevoked: db.verClaims.filter((c) => c.status === 'revoked' && c.revokedAt > now - 14 * 86_400_000).map(adminClaimRow),
      queueOldestMs: queueAges.length ? Math.max(...queueAges) : 0,
    });
  });
  function adminClaimRow(c) {
    const org = c.organisationId ? orgOf(c.organisationId) : null;
    const subject = c.subjectType === 'user' ? db.users.find((u) => u.id === c.subjectId) : orgOf(c.subjectId);
    return {
      id: c.id, claimType: c.claimType, status: c.status, role: c.role,
      subject: { type: c.subjectType, id: c.subjectId, name: subject?.name ?? '(unknown)' },
      organisation: org ? { id: org.id, name: org.name, status: ctx.orgVerificationStatus(org) } : null,
      reviewReasons: c.reviewReasons, riskFlags: c.riskFlags, assignedTo: c.metadata?.assignedTo ?? null,
      createdAt: c.createdAt, updatedAt: c.updatedAt, disputedAt: c.disputedAt,
    };
  }

  adminRouter.get('/verification/cases/:id', (req, res) => {
    const c = claimById(req.params.id);
    if (!c) return res.status(404).json({ error: 'CASE_NOT_FOUND' });
    const subjectUser = c.subjectType === 'user' ? db.users.find((u) => u.id === c.subjectId) : null;
    res.json({
      claim: c, row: adminClaimRow(c),
      evidence: db.verEvidence.filter((e) => c.evidenceIds.includes(e.id)),
      priorClaims: idx.claimsFor(c.subjectType, c.subjectId).filter((x) => x.id !== c.id),
      conflicts: subjectUser ? db.verConflicts.filter((x) => x.userId === subjectUser.id && !x.withdrawnAt) : [],
      disputes: db.verDisputes.filter((d) => d.claimId === c.id),
      whyHumanReview: c.reviewReasons,
      events: db.verEvents.filter((e) => e.claimId === c.id), // chronological — append-only
    });
  });

  adminRouter.post('/verification/cases/:id/assign', (req, res) => {
    const c = claimById(req.params.id);
    if (!c) return res.status(404).json({ error: 'CASE_NOT_FOUND' });
    c.metadata.assignedTo = String(req.body?.reviewer ?? 'Trust & Safety').slice(0, 60);
    verEvent('review.assigned', { claimId: c.id, after: { reviewer: c.metadata.assignedTo } });
    persistNow();
    res.json({ assigned: c.metadata.assignedTo });
  });

  // Consequential decisions all REQUIRE a reason (§23) and land in the
  // append-only event log with before/after.
  const reasonRequired = (req, res) => {
    if (String(req.body?.reason ?? '').trim()) return true;
    res.status(400).json({ error: 'REASON_REQUIRED', message: 'Manual verification decisions require a written reason — it is audited.' });
    return false;
  };

  adminRouter.post('/verification/claims/:id/approve', (req, res) => {
    const c = claimById(req.params.id);
    if (!c) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    if (!reasonRequired(req, res)) return;
    if (!['requires_human_review', 'automated_checks_passed', 'pending'].includes(c.status)) {
      return res.status(409).json({ error: 'CLAIM_NOT_DECIDABLE', message: `Claim is ${c.status}.` });
    }
    if (['pending', 'requires_human_review'].includes(c.status)) {
      const hop = c.status === 'pending' ? 'requires_human_review' : null;
      if (hop) adminTransition(c, hop, req, { reason: 'escalated for manual decision' });
    }
    const method = c.claimType === 'LICENCE' ? 'scoutbox_manual_review' : (req.body?.method && ['scoutbox_manual_review', 'federation_confirmation', 'authoritative_registry'].includes(req.body.method) ? req.body.method : 'scoutbox_manual_review');
    const err = adminTransition(c, 'verified', req, { method, reason: req.body.reason, eventType: 'review.approved' });
    if (err) return res.status(409).json({ error: err });
    c.authorityType = 'trust_safety'; c.authorityId = 'admin';
    if (c.claimType === 'LICENCE') {
      // A manual document review is labelled as exactly that — it is NOT a
      // register check, and the display copy says so.
      c.metadata.display = method === 'authoritative_registry'
        ? `Licence verified: ${c.metadata.licenceType}`
        : `${c.metadata.licenceType}: confirmed by Trust & Safety document review (not an independent register check)`;
    }
    if (c.subjectType === 'user') notify({ kind: 'org_user', id: c.subjectId }, 'verification', `Trust & Safety approved your ${c.claimType.replace(/_/g, ' ').toLowerCase()} verification. ✓`, c.id);
    persistNow();
    res.json({ claim: c });
  });

  adminRouter.post('/verification/claims/:id/reject', (req, res) => {
    const c = claimById(req.params.id);
    if (!c) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    if (!reasonRequired(req, res)) return;
    if (!['requires_human_review', 'automated_checks_passed', 'pending'].includes(c.status)) {
      return res.status(409).json({ error: 'CLAIM_NOT_DECIDABLE' });
    }
    if (c.status === 'pending') adminTransition(c, 'requires_human_review', req, { reason: 'escalated' });
    const err = adminTransition(c, 'rejected', req, { reason: req.body.reason, eventType: 'review.rejected' });
    if (err) return res.status(409).json({ error: err });
    if (c.subjectType === 'user') notify({ kind: 'org_user', id: c.subjectId }, 'verification', `Trust & Safety declined a verification request: ${String(req.body.reason).slice(0, 140)}`, c.id);
    persistNow();
    res.json({ claim: c });
  });

  adminRouter.post('/verification/claims/:id/request-info', (req, res) => {
    const c = claimById(req.params.id);
    if (!c) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    if (!reasonRequired(req, res)) return;
    const err = adminTransition(c, 'collecting_evidence', req, { reason: req.body.reason });
    if (err) return res.status(409).json({ error: err });
    if (c.subjectType === 'user') notify({ kind: 'org_user', id: c.subjectId }, 'verification', `Trust & Safety needs more evidence: ${String(req.body.reason).slice(0, 140)}`, c.id);
    persistNow();
    res.json({ claim: c });
  });

  for (const [action, target] of [['suspend', 'suspended'], ['revoke', 'revoked']]) {
    adminRouter.post(`/verification/claims/:id/${action}`, (req, res) => {
      const c = claimById(req.params.id);
      if (!c) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
      if (!reasonRequired(req, res)) return;
      const err = adminTransition(c, target, req, { reason: req.body.reason, eventType: `claim.${target}` });
      if (err) return res.status(409).json({ error: err });
      if (c.subjectType === 'user') notify({ kind: 'org_user', id: c.subjectId }, 'verification', `A verification claim was ${target} by Trust & Safety: ${String(req.body.reason).slice(0, 140)}. You can dispute this.`, c.id);
      persistNow();
      res.json({ claim: c, note: 'Effective badges change immediately; the historical audit trail is preserved.' });
    });
  }

  adminRouter.post('/verification/claims/:id/reinstate', (req, res) => {
    const c = claimById(req.params.id);
    if (!c) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    if (!reasonRequired(req, res)) return;
    if (!['suspended', 'revoked', 'disputed'].includes(c.status)) return res.status(409).json({ error: 'NOT_REINSTATABLE' });
    const err = adminTransition(c, 'verified', req, { method: c.verificationMethod, reason: req.body.reason, eventType: 'claim.reinstated' });
    if (err) return res.status(409).json({ error: err });
    persistNow();
    res.json({ claim: c });
  });

  // ================================================ root requests (§6/V4)
  adminRouter.post('/verification/root-requests/:id/approve', (req, res) => {
    const r = db.verRootRequests.find((x) => x.id === req.params.id);
    if (!r) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
    if (!reasonRequired(req, res)) return;
    if (r.status !== 'requires_human_review') return res.status(409).json({ error: 'REQUEST_NOT_DECIDABLE', message: `Request is ${r.status}.` });
    // Organisation: attach to the matched existing org, or create a new one.
    let org = r.existingOrgId ? orgOf(r.existingOrgId) : null;
    if (!org) {
      org = {
        id: nextId('org'), name: r.orgName, type: r.orgType === 'agency' ? 'agency' : 'club',
        level: r.orgType === 'grassroots club' ? 'grassroots' : null,
        plan: r.orgType === 'grassroots club' ? 'Grassroots' : 'Pro', trustedPartner: false,
        country: r.country, verified: false, verifiedDomain: null, safeguardingContractSigned: false,
        ...(r.orgType === 'grassroots club' ? { location: { lat: 51.5, lng: -0.1, city: '' }, federationRef: r.federation ? { federation: r.federation, registrationId: 'pending' } : null, squad: [] } : {}),
        verification: { domains: [], revokedAt: null, orgType: r.orgType },
      };
      db.orgs.push(org);
    }
    org.verification ??= { domains: [], revokedAt: null, orgType: r.orgType };
    // Applicant becomes (or maps to) an org user…
    let user = db.users.find((u) => u.orgId === org.id && !u.removedAt && (u.email?.toLowerCase() === r.workEmail || u.name.toLowerCase() === r.applicantName.toLowerCase()));
    if (!user) {
      user = { id: nextId('usr'), orgId: org.id, name: r.applicantName, role: r.applicantRole, email: r.workEmail, createdAt: Date.now() };
      db.users.push(user);
    }
    user.email ??= r.workEmail;
    // …organisation identity claim: established by Trust & Safety review.
    createClaim({
      subjectType: 'org', subjectId: org.id, claimType: 'ORGANISATION_IDENTITY', organisationId: org.id,
      status: 'verified', verificationMethod: 'scoutbox_manual_review', verifiedAt: Date.now(),
      verifiedBy: { kind: 'trust_safety', id: 'admin' }, evidenceIds: [...r.evidenceIds],
      metadata: { rootRequest: r.id, orgType: r.orgType, website: r.website },
    });
    // Keep the LEGACY effective flag in sync — same standing meaning: minors
    // still additionally need the safeguarding contract (unchanged).
    org.verified = true;
    // Domain claim only where the mailbox proof aligns with the stated domain.
    if (r.emailProved && r.domain && domainCovered(domainOfEmail(r.workEmail), r.domain)) {
      org.verification.domains.push({ domain: r.domain, status: 'verified', method: 'official_domain_email', verifiedAt: Date.now(), addedBy: 'root_request' });
      createClaim({
        subjectType: 'org', subjectId: org.id, claimType: 'ORGANISATION_DOMAIN', organisationId: org.id,
        status: 'verified', verificationMethod: 'official_domain_email', verifiedAt: Date.now(),
        verifiedBy: { kind: 'trust_safety', id: 'admin' }, metadata: { domain: r.domain, rootRequest: r.id },
      });
    }
    // Root administrator authority + its claim.
    createClaim({
      subjectType: 'user', subjectId: user.id, claimType: 'ORGANISATION_ADMIN', organisationId: org.id,
      status: 'verified', verificationMethod: 'scoutbox_manual_review', verifiedAt: Date.now(),
      verifiedBy: { kind: 'trust_safety', id: 'admin' }, metadata: { rootRequest: r.id, level: 'verification_root_admin' },
    });
    db.verAdmins.push({ id: nextId('vadm'), orgId: org.id, userId: user.id, level: 'verification_root_admin', status: 'active', invitedBy: 'trust_safety', createdAt: Date.now(), acceptedAt: Date.now(), revokedAt: null, revokedBy: null });
    r.status = 'approved'; r.decidedAt = Date.now(); r.decidedBy = 'Trust & Safety'; r.decisionReason = String(req.body.reason).slice(0, 400);
    r.resultOrgId = org.id; r.resultUserId = user.id;
    verEvent('review.approved', { orgId: org.id, subjectId: user.id, after: { rootRequest: r.id, org: org.id, rootAdmin: user.id }, reason: r.decisionReason, actorKind: 'trust_safety', actorName: 'Trust & Safety' });
    ctx.ledgerAppend?.({ type: 'verification_root_approved', orgId: org.id, playerId: null, detail: { request: r.id } });
    persistNow();
    res.json({
      request: { ...r, applicantSecretHash: undefined }, orgId: org.id, rootAdminUserId: user.id,
      note: 'The organisation is verified and its first root administrator is established. Staff verification is now self-service through the club. Sign-in credentials are provisioned separately (POST /admin/clubs/:id/credentials).',
    });
  });

  adminRouter.post('/verification/root-requests/:id/reject', (req, res) => {
    const r = db.verRootRequests.find((x) => x.id === req.params.id);
    if (!r) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
    if (!reasonRequired(req, res)) return;
    if (!['requires_human_review', 'collecting_evidence'].includes(r.status)) return res.status(409).json({ error: 'REQUEST_NOT_DECIDABLE' });
    r.status = 'rejected'; r.decidedAt = Date.now(); r.decidedBy = 'Trust & Safety'; r.decisionReason = String(req.body.reason).slice(0, 400);
    verEvent('review.rejected', { after: { rootRequest: r.id }, reason: r.decisionReason, actorKind: 'trust_safety' });
    persistNow();
    res.json({ request: { ...r, applicantSecretHash: undefined } });
  });

  // Appoint a root admin for an org that is ALREADY verified (e.g. migrated
  // legacy orgs) — a T&S action with a reason, never self-service.
  adminRouter.post('/verification/orgs/:id/appoint-root', (req, res) => {
    const org = orgOf(req.params.id);
    if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    if (!reasonRequired(req, res)) return;
    if (!org.verified) return res.status(409).json({ error: 'ORG_NOT_VERIFIED', message: 'Verify the organisation first — root authority only exists inside a verified organisation.' });
    const user = db.users.find((u) => u.id === req.body?.userId && u.orgId === org.id && !u.removedAt);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    if (db.verAdmins.some((a) => a.orgId === org.id && a.userId === user.id && a.level === 'verification_root_admin' && a.status === 'active')) {
      return res.status(409).json({ error: 'ALREADY_ROOT_ADMIN' });
    }
    db.verAdmins.push({ id: nextId('vadm'), orgId: org.id, userId: user.id, level: 'verification_root_admin', status: 'active', invitedBy: 'trust_safety', createdAt: Date.now(), acceptedAt: Date.now(), revokedAt: null, revokedBy: null });
    createClaim({
      subjectType: 'user', subjectId: user.id, claimType: 'ORGANISATION_ADMIN', organisationId: org.id,
      status: 'verified', verificationMethod: 'scoutbox_manual_review', verifiedAt: Date.now(),
      verifiedBy: { kind: 'trust_safety', id: 'admin' }, metadata: { appointedReason: String(req.body.reason).slice(0, 300) },
    });
    notify({ kind: 'org_user', id: user.id }, 'verification', `Trust & Safety appointed you root verification administrator for ${org.name}.`, org.id);
    persistNow();
    res.status(201).json({ orgId: org.id, rootAdminUserId: user.id });
  });

  // Domain requests escalated to T&S (root/contested changes, §8).
  adminRouter.get('/verification/domain-requests', (_req, res) => {
    res.json({ items: db.verDomainRequests.filter((r) => r.status === 'requires_human_review') });
  });
  adminRouter.post('/verification/domain-requests/:id/decide', (req, res) => {
    const r = db.verDomainRequests.find((x) => x.id === req.params.id);
    if (!r) return res.status(404).json({ error: 'DOMAIN_REQUEST_NOT_FOUND' });
    if (!reasonRequired(req, res)) return;
    if (r.status !== 'requires_human_review') return res.status(409).json({ error: 'NOT_DECIDABLE' });
    const org = orgOf(r.orgId);
    if (req.body?.approve === true && org) {
      r.status = 'verified'; r.method = 'scoutbox_manual_review';
      org.verification.domains.push({ domain: r.domain, status: 'verified', method: 'scoutbox_manual_review', verifiedAt: Date.now(), addedBy: 'trust_safety' });
      createClaim({
        subjectType: 'org', subjectId: org.id, claimType: 'ORGANISATION_DOMAIN', organisationId: org.id,
        status: 'verified', verificationMethod: 'scoutbox_manual_review', verifiedAt: Date.now(),
        verifiedBy: { kind: 'trust_safety', id: 'admin' }, metadata: { domain: r.domain },
      });
      verEvent('organisation.domain_verified', { orgId: org.id, after: { domain: r.domain, via: 'trust_safety' }, reason: req.body.reason });
    } else {
      r.status = 'rejected';
      verEvent('review.rejected', { orgId: r.orgId, after: { domainRequest: r.id }, reason: req.body.reason });
    }
    r.decidedAt = Date.now(); r.decidedBy = 'Trust & Safety';
    persistNow();
    res.json({ request: r });
  });

  // ======================================================= disputes (§16)
  adminRouter.get('/verification/disputes', (_req, res) => {
    res.json({
      items: db.verDisputes.map((d) => ({ ...d, claim: claimById(d.claimId) ? adminClaimRow(claimById(d.claimId)) : null })),
    });
  });
  adminRouter.post('/verification/disputes/:id/resolve', (req, res) => {
    const d = db.verDisputes.find((x) => x.id === req.params.id);
    if (!d) return res.status(404).json({ error: 'DISPUTE_NOT_FOUND' });
    if (d.status !== 'open') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    if (!reasonRequired(req, res)) return;
    const { action } = req.body ?? {}; // reinstate | revoke | correct | dismiss
    const c = claimById(d.claimId);
    if (c && c.status === 'disputed') {
      if (action === 'reinstate' || action === 'dismiss') adminTransition(c, 'verified', req, { method: c.verificationMethod, reason: req.body.reason, eventType: 'claim.reinstated' });
      else if (action === 'revoke') adminTransition(c, 'revoked', req, { reason: req.body.reason });
      else if (action === 'correct') {
        adminTransition(c, 'verified', req, { method: c.verificationMethod, reason: req.body.reason, eventType: 'claim.corrected' });
        if (req.body.role) c.role = String(req.body.role).slice(0, 60);
        if (req.body.validUntil !== undefined) c.validUntil = Number(req.body.validUntil) || null;
        if (req.body.current !== undefined) c.current = !!req.body.current;
      }
    } else if (c && action === 'correct') {
      if (req.body.validUntil !== undefined) c.validUntil = Number(req.body.validUntil) || null;
      if (req.body.current !== undefined) c.current = !!req.body.current;
      verEvent('claim.corrected', { claimId: c.id, subjectId: c.subjectId, orgId: c.organisationId, reason: req.body.reason, actorKind: 'trust_safety' });
    }
    d.status = 'resolved'; d.resolvedAt = Date.now(); d.resolvedBy = 'Trust & Safety';
    d.resolution = `${action}: ${String(req.body.reason).slice(0, 300)}`;
    if (d.byKind === 'org_user') notify({ kind: 'org_user', id: d.byId }, 'verification', `Your verification dispute was resolved: ${d.resolution.slice(0, 140)}`, d.claimId);
    persistNow();
    res.json({ dispute: d, claim: c ?? null });
  });

  // =========================================== authority cascade (§52/§53)
  adminRouter.get('/verification/authorities/:userId/claims', (req, res) => {
    res.json({
      items: idx.claimsByAuthority(req.params.userId).map(adminClaimRow),
      note: 'Claims this authority approved. Revoking an authority never silently destroys them — flag or suspend per policy after analysis.',
    });
  });
  adminRouter.post('/verification/authorities/:userId/flag', (req, res) => {
    if (!reasonRequired(req, res)) return;
    const affected = idx.claimsByAuthority(req.params.userId);
    const toSuspend = new Set(Array.isArray(req.body?.suspendClaimIds) ? req.body.suspendClaimIds : []);
    let flagged = 0, suspended = 0;
    for (const c of affected) {
      if (toSuspend.has(c.id) && c.status === 'verified') {
        const err = adminTransition(c, 'suspended', req, { reason: req.body.reason });
        if (!err) suspended++;
      } else if (!c.metadata.flaggedForReview) {
        c.metadata.flaggedForReview = { at: Date.now(), reason: String(req.body.reason).slice(0, 300) };
        verEvent('review.requested', { claimId: c.id, subjectId: c.subjectId, orgId: c.organisationId, reason: 'authority cascade flag', actorKind: 'trust_safety' });
        flagged++;
      }
    }
    persistNow();
    res.json({ affected: affected.length, flagged, suspended });
  });

  // Organisation lifecycle from T&S (suspension uses the EXISTING org
  // suspension mechanics; revocation is verification-specific).
  adminRouter.post('/verification/orgs/:id/revoke', (req, res) => {
    const org = orgOf(req.params.id);
    if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    if (!reasonRequired(req, res)) return;
    org.verification.revokedAt = Date.now();
    org.verified = false; // effective flag follows immediately
    for (const c of idx.claimsFor('org', org.id)) {
      if (c.status === 'verified') adminTransition(c, 'revoked', req, { reason: req.body.reason });
    }
    verEvent('claim.revoked', { orgId: org.id, reason: req.body.reason, actorKind: 'trust_safety', after: { organisation: 'revoked' } });
    persistNow();
    res.json({ orgId: org.id, status: ctx.orgVerificationStatus(org), note: 'Staff claims verified through this organisation stop displaying (engine re-checks at read time); their audit history is preserved.' });
  });

  // =============================================== legacy-route sync (§48)
  // The pre-M14 admin toggle (POST /admin/clubs/:id/verification) stays
  // functional; this hook gives its changes claim-level provenance so the two
  // systems can never drift apart.
  ctx.syncLegacyOrgVerification = (org, body) => {
    if (body?.verified === undefined) return;
    org.verification ??= { domains: [], revokedAt: null, orgType: org.type === 'agency' ? 'agency' : (org.level === 'grassroots' ? 'grassroots club' : 'professional club') };
    const existing = idx.claimsFor('org', org.id).find((c) => c.claimType === 'ORGANISATION_IDENTITY');
    if (body.verified && (!existing || existing.status !== 'verified')) {
      if (existing && ['revoked', 'suspended'].includes(existing.status)) {
        transition(existing, 'verified', { actorKind: 'trust_safety', actorName: 'Trust & Safety', method: 'scoutbox_manual_review', reason: 'legacy admin verification toggle', eventType: 'claim.reinstated' });
        org.verification.revokedAt = null;
      } else if (!existing) {
        createClaim({
          subjectType: 'org', subjectId: org.id, claimType: 'ORGANISATION_IDENTITY', organisationId: org.id,
          status: 'verified', verificationMethod: 'scoutbox_manual_review', verifiedAt: Date.now(),
          verifiedBy: { kind: 'trust_safety', id: 'admin' }, metadata: { via: 'legacy admin route' },
        });
      }
      org.verification.revokedAt = null;
    } else if (body.verified === false && existing && existing.status === 'verified') {
      transition(existing, 'revoked', { actorKind: 'trust_safety', actorName: 'Trust & Safety', reason: 'legacy admin verification toggle removed verification' });
    }
  };

  // =============================================== deterministic sweep (§36)
  ctx.verificationSweep = () => {
    const now = Date.now();
    let changed = 0;
    for (const c of db.verClaims) {
      if (c.status === 'verified' && c.current !== false && c.validUntil && c.validUntil < now) {
        transition(c, 'expired', { actorKind: 'system', eventType: 'claim.expired' });
        if (c.subjectType === 'user') notify({ kind: 'org_user', id: c.subjectId }, 'verification', `A verification claim expired (${c.claimType.replace(/_/g, ' ').toLowerCase()}${c.metadata?.licenceType ? `: ${c.metadata.licenceType}` : ''}). Reconfirm it from Verification.`, c.id);
        changed++;
      } else if (c.status === 'verified' && c.validUntil && !c.metadata.expiryWarned && c.validUntil < now + 30 * 86_400_000 && c.validUntil > now) {
        c.metadata.expiryWarned = now;
        if (c.subjectType === 'user') notify({ kind: 'org_user', id: c.subjectId }, 'verification', `A verification claim expires soon — reconfirm before ${new Date(c.validUntil).toDateString()}.`, c.id);
        changed++;
      }
    }
    if (changed) persist();
    return changed;
  };
}
