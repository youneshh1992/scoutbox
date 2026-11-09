// Trust & Safety review, licence verification, disputes, cascades and
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
import { parseDateOrInstant, isAbsent } from '../../../temporal.mjs';
import { VERIFICATION_LIMITS as L } from '../../../repositories/verification.mjs';

// ---------------------------------------------------------------- registry
// Licence-registry adapter. Interface every future FA/UEFA/
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
    byId, users, orgs, orgRouter, adminRouter, nextId, notify,
    verification, reads, unit, verEvent, createClaim, transition, addEvidence, storeEvidenceFile,
    effectiveStatus, vmetric, requireVer, hasVerLevel,
  } = ctx;

  const orgOf = (id) => byId.org(id) ?? null;
  const claimById = (id) => reads.claims.byId(id);
  const fieldInvalid = (res, field, message) => res.status(400).json({ error: 'FIELD_INVALID', field, message });
  /** Run a sequence of transitions as one unit; the first refusal undoes them all and is returned. */
  const allOrNothing = (fn) => {
    try { unit(() => { const err = fn(); if (err) throw Object.assign(new Error(err), { transitionError: err }); }); } catch (e) { if (e.transitionError) return e.transitionError; throw e; }
    return null;
  };
  // Attribution: the admin surface may authenticate with one SHARED key, which identifies no individual. A request
  // may DECLARE its reviewer (x-admin-reviewer-id / x-admin-reviewer-name); every consequential decision then
  // records that declared identity, the correlation id and the attribution mode. When no reviewer is declared,
  // events honestly say `shared_admin_key` instead of inventing a person.
  const reviewerOf = (req) => {
    // An AUTHENTICATED reviewer session, when presented
    // beside the shared key, is the attribution — derived by the server from
    // the session, never from a header a caller typed.
    if (req?.reviewer?.id) return { id: String(req.reviewer.id).slice(0, L.id), name: String(req.reviewer.name ?? req.reviewer.id).slice(0, L.name), attribution: 'authenticated_reviewer' };
    const id = String(req?.headers?.['x-admin-reviewer-id'] ?? '').trim().slice(0, 60);
    const name = String(req?.headers?.['x-admin-reviewer-name'] ?? '').trim().slice(0, 80);
    return id
      ? { id, name: name || id, attribution: 'declared_reviewer' }
      : { id: 'admin', name: 'Trust & Safety', attribution: 'shared_admin_key' };
  };
  const adminTransition = (claim, to, req, opts = {}, also = {}) => {
    const rev = reviewerOf(req);
    return transition(claim, to, { actorKind: 'trust_safety', actorId: rev.id, actorName: rev.name, attribution: rev.attribution, ...opts }, req, also);
  };
  const reasonText = (req) => String(req.body.reason);

  // ============================================================ licences
  orgRouter.get('/verification/licence-providers', (_req, res) => {
    res.json({
      providers: licenceProviders(),
      note: 'No production governing-body register is connected. Providers listed not_configured are real integration points, not working integrations.',
    });
  });

  orgRouter.post('/verification/licence', (req, res) => {
    const { licenceType, issuer, identifier, issueDate, expiry, dataUrl, filename, holderName } = req.body ?? {};
    if (typeof licenceType !== 'string' || typeof issuer !== 'string' || !licenceType.trim() || !issuer.trim()) return res.status(400).json({ error: 'FIELDS_REQUIRED', message: 'licenceType and issuer are required.' });
    for (const [k, v] of [['identifier', identifier], ['holderName', holderName], ['filename', filename]]) if (!(v === undefined || v === null || typeof v === 'string')) return fieldInvalid(res, k, `${k} is text.`);
    // A malformed expiry is refused, not read as "no expiry". A DATE_ONLY expiry
    // covers the whole day (the licence is valid THROUGH that day).
    const exp = isAbsent(expiry) ? null : parseDateOrInstant(expiry, { dayEdge: 'end' });
    if (exp && !exp.ok) return res.status(400).json({ error: 'DATE_INVALID', field: 'expiry', message: `An expiry is a calendar day written YYYY-MM-DD (${exp.why}).`, expected: 'YYYY-MM-DD' });
    const issued = isAbsent(issueDate) ? null : parseDateOrInstant(issueDate, { dayEdge: 'start' });
    if (issued && !issued.ok) return res.status(400).json({ error: 'DATE_INVALID', field: 'issueDate', message: `An issue date is a calendar day written YYYY-MM-DD (${issued.why}).`, expected: 'YYYY-MM-DD' });
    if (issued && exp && !(issued.ms < exp.ms)) return res.status(400).json({ error: 'INTERVAL_INVALID', field: 'expiry', message: 'A licence cannot expire before it was issued.' });
    // The file is checked and stored first, so a refused file leaves no claim behind.
    let stored = null;
    if (dataUrl) {
      stored = storeEvidenceFile(dataUrl, filename, req);
      if (stored.error) return res.status(422).json({ error: stored.error });
    }
    // The issue and expiry days are the claim's validFrom / validUntil (the raw inputs are not kept twice).
    const claim = unit(() => {
      const created = createClaim({
        subjectType: 'user', subjectId: req.orgUser.id, claimType: 'LICENCE',
        organisationId: null, status: 'collecting_evidence', verificationMethod: 'document_submitted',
        validFrom: issued ? issued.ms : null,
        validUntil: exp ? exp.ms : null,
        metadata: {
          licenceType: String(licenceType).slice(0, L.licenceType), issuer: String(issuer).slice(0, L.issuer),
          identifier: String(identifier ?? '').slice(0, L.identifier) || null,
          holderName: String(holderName ?? req.orgUser.name).slice(0, L.holderName),
          display: 'Credential submitted — verification pending', // never "Licence verified" from an upload
        },
      }, req);
      if (stored) {
        addEvidence({
          type: 'document', source: 'subject_upload', suppliedByKind: 'org_user', suppliedById: req.orgUser.id,
          orgId: req.org.id, claimIds: [created.id], ...stored, visibility: 'trust_and_safety',
        }, req);
      }
      return created;
    });
    res.status(201).json({
      claim: { id: claim.id, status: claim.status, display: claim.metadata.display },
      note: 'An uploaded credential is a document, not a verified licence. Submit it to run the registry check (where a register is configured) or route it to review.',
    });
  });

  orgRouter.post('/verification/licence/:id/submit', (req, res) => {
    const own = reads.claims.byId(req.params.id);
    const claim = own && own.subjectId === req.orgUser.id && own.claimType === 'LICENCE' ? own : null;
    if (!claim) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    if (!['collecting_evidence', 'pending'].includes(claim.status)) return res.status(409).json({ error: 'ALREADY_SUBMITTED' });
    if (!(req.body?.providerId === undefined || req.body?.providerId === null || (typeof req.body.providerId === 'string' && req.body.providerId.length <= L.provider))) return fieldInvalid(res, 'providerId', `providerId is text of at most ${L.provider} characters.`);
    if (claim.status === 'collecting_evidence') {
      const err = transition(claim, 'pending', { actorKind: 'org_user', actorId: req.orgUser.id }, req);
      if (err) return res.status(409).json({ error: err });
    }
    const providerId = String(req.body?.providerId ?? 'local-test-registry');
    const lookup = lookupCredential({ providerId, identifier: claim.metadata.identifier, holderName: String(claim.metadata.holderName ?? '').toLowerCase() });
    verEvent(lookup.result ? 'automated_check.passed' : 'automated_check.failed', { claimId: claim.id, subjectId: claim.subjectId, after: { provider: providerId, state: lookup.state, result: lookup.result } }, req);
    const view = () => { const c = reads.claims.byId(claim.id); return { id: c.id, status: c.status, display: c.metadata.display }; };
    if (lookup.state !== 'configured') {
      // Fail HONEST: unavailable/unconfigured providers leave the claim
      // pending — never "verified", never "rejected".
      const registry = { provider: providerId, state: lookup.state, checkedAt: Date.now() };
      const routed = transition(claim, 'requires_human_review', { actorKind: 'system', reason: 'no authoritative register available' }, req, { metadata: { registry }, addReviewReasons: ['NO_AUTHORITATIVE_SOURCE', 'DOCUMENT_AUTHENTICITY_UNCONFIRMED'] });
      vmetric('routedToHumanReview');
      return res.json({
        claim: view(),
        provider: { id: providerId, state: lookup.state },
        note: lookup.state === 'temporarily_unavailable'
          ? 'Verification provider unavailable — verification remains pending.'
          : 'No authoritative register is configured for this issuer — a reviewer can perform a document review, which is labelled as a document review.',
        routed: routed ? null : 'requires_human_review',
      });
    }
    if (lookup.result === 'match') {
      const rec = lookup.record;
      // The register's expiry must be readable before it can verify anything: the
      // SELF-DECLARED expiry never stands in for an unreadable authoritative one.
      const regUntil = isAbsent(rec.validUntil) ? null : parseDateOrInstant(rec.validUntil, { dayEdge: 'end' });
      if (regUntil && !regUntil.ok) {
        const registry = { provider: providerId, result: 'unreadable_record', checkedAt: Date.now(), reference: rec.identifier };
        transition(claim, 'requires_human_review', { actorKind: 'system', reason: 'registry record carried an unreadable expiry' }, req, { metadata: { registry }, addReviewReasons: ['REGISTRY_RECORD_UNREADABLE'] });
        vmetric('routedToHumanReview');
        return res.json({ claim: view(), provider: { id: providerId, result: 'unreadable_record' }, note: 'The register matched but its expiry date could not be read. Nothing is verified from a record that cannot be dated; a reviewer decides.' });
      }
      const err = allOrNothing(() => {
        addEvidence({
          type: 'registry_result', source: providerId, suppliedByKind: 'system', suppliedById: null,
          orgId: req.org.id, claimIds: [claim.id], visibility: 'trust_and_safety',
          meta: { identifier: rec.identifier, licenceType: rec.licenceType, validUntil: rec.validUntil },
        }, req);
        const registry = { provider: providerId, result: 'match', checkedAt: Date.now(), reference: rec.identifier };
        return transition(claim, 'automated_checks_passed', { actorKind: 'system' }, req, {
          set: regUntil ? { validUntil: regUntil.ms } : {},
          metadata: { display: `Licence verified: ${rec.licenceType}`, registry },
        }) ?? transition(claim, 'verified', { actorKind: 'system', method: 'authoritative_registry', eventType: 'claim.verified' }, req);
      });
      if (err) return res.status(409).json({ error: err });
      return res.json({ claim: view(), provider: { id: providerId, result: 'match' } });
    }
    if (lookup.result === 'ambiguous') {
      transition(claim, 'requires_human_review', { actorKind: 'system', reason: 'registry returned an ambiguous match' }, req, { addReviewReasons: ['REGISTRY_AMBIGUOUS_MATCH'] });
      vmetric('routedToHumanReview');
      return res.json({ claim: view(), provider: { id: providerId, result: 'ambiguous' }, note: 'The register returned more than one plausible record — a human resolves ambiguity, never a guess.' });
    }
    // no_match: absence of a record VERIFIES NOTHING and PROVES NOTHING.
    const registry = { provider: providerId, result: 'no_match', checkedAt: Date.now() };
    transition(claim, 'requires_human_review', { actorKind: 'system', reason: 'registry found no matching record' }, req, { metadata: { registry }, addReviewReasons: ['DOCUMENT_AUTHENTICITY_UNCONFIRMED'] });
    vmetric('routedToHumanReview');
    res.json({ claim: view(), provider: { id: providerId, result: 'no_match' }, note: 'No register record matched. The credential stays unverified; a reviewer can examine the evidence.' });
  });

  // ================================================= evidence access
  // T&S: everything, every read logged. Org reviewers: organisation_internal
  // evidence of their OWN org only. Subjects: their own uploads' metadata via
  // the subject claim view (organisations.mjs). Nothing is ever public.
  adminRouter.get('/verification/evidence/:id', (req, res) => {
    const ev = reads.evidence.byId(req.params.id);
    if (!ev) return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    verEvent('evidence.accessed', { claimId: ev.claimIds[0] ?? null, subjectId: ev.suppliedById, orgId: ev.orgId, after: { evidenceId: ev.id, by: 'trust_safety' } });
    const blob = ev.mediaId ? ctx.storage.read(ev.mediaId) : null;
    res.json({ evidence: ev, file: blob ? { mime: blob.contentType, base64: blob.buffer.toString('base64') } : null });
  });
  orgRouter.get('/verification/evidence/:id', (req, res) => {
    const ev = reads.evidence.byId(req.params.id);
    // Concealment: wrong org / wrong visibility looks identical to missing.
    if (!ev || ev.orgId !== req.org.id || ev.visibility !== 'organisation_internal') {
      return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    }
    if (!requireVer(req, res, 'verification_reviewer')) return;
    verEvent('evidence.accessed', { subjectId: ev.suppliedById, orgId: ev.orgId, after: { evidenceId: ev.id, by: req.orgUser.id } }, req);
    res.json({ evidence: { ...ev, mediaId: undefined } });
  });

  // ==================================================== T&S review queue
  adminRouter.get('/verification/queue', (req, res) => {
    const now = Date.now();
    const q = (k) => (typeof req.query[k] === 'string' && req.query[k] ? req.query[k] : null);
    const [orgId, country, claimType, status] = ['orgId', 'country', 'claimType', 'status'].map(q);
    const states = ['requires_human_review', 'disputed', 'suspended'];
    const claims = reads.claims.inStatuses(status ? states.filter((s2) => s2 === status) : states, { orgId, claimType });
    const roots = reads.rootRequests.awaitingReview(country);
    const queueAges = claims.filter((c) => c.status === 'requires_human_review').map((c) => now - c.updatedAt);
    res.json({
      humanReview: claims.filter((c) => c.status === 'requires_human_review').map(adminClaimRow),
      rootRequests: roots.map((r) => ({ ...r, applicantSecretHash: undefined })),
      disputes: reads.disputes.open(),
      suspended: claims.filter((c) => c.status === 'suspended').map(adminClaimRow),
      disputedClaims: claims.filter((c) => c.status === 'disputed').map(adminClaimRow),
      domainRequests: reads.domainRequests.awaitingReview(),
      expiring: reads.claims.expiringBetween(now, now + 30 * 86_400_000).map(adminClaimRow),
      recentlyRevoked: reads.claims.revokedSince(now - 14 * 86_400_000).map(adminClaimRow),
      queueOldestMs: queueAges.length ? Math.max(...queueAges) : 0,
    });
  });
  function adminClaimRow(c) {
    const org = c.organisationId ? orgOf(c.organisationId) : null;
    const subject = c.subjectType === 'user' ? byId.user(c.subjectId) : orgOf(c.subjectId);
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
    const subjectUser = c.subjectType === 'user' ? byId.user(c.subjectId) : null;
    res.json({
      claim: c, row: adminClaimRow(c),
      evidence: reads.evidence.byIds(c.evidenceIds),
      priorClaims: reads.claims.forSubject(c.subjectType, c.subjectId).filter((x) => x.id !== c.id),
      conflicts: subjectUser ? reads.conflicts.activeForUser(subjectUser.id) : [],
      disputes: reads.disputes.forClaim(c.id),
      whyHumanReview: c.reviewReasons,
      events: reads.events.forClaim(c.id), // chronological — append-only
    });
  });

  adminRouter.post('/verification/cases/:id/assign', (req, res) => {
    const c = claimById(req.params.id);
    if (!c) return res.status(404).json({ error: 'CASE_NOT_FOUND' });
    if (!(req.body?.reviewer === undefined || req.body?.reviewer === null || typeof req.body.reviewer === 'string')) return fieldInvalid(res, 'reviewer', 'reviewer is text.');
    const assignedTo = String(req.body?.reviewer ?? 'Trust & Safety').slice(0, L.assignedTo);
    unit(() => {
      verification.claims.assign(c.id, { assignedTo });
      verEvent('review.assigned', { claimId: c.id, after: { reviewer: assignedTo } });
    });
    res.json({ assigned: assignedTo });
  });

  // Consequential decisions all REQUIRE a reason and land in the
  // append-only event log with before/after.
  const reasonRequired = (req, res) => {
    if (typeof req.body?.reason === 'string' && req.body.reason.trim()) return true;
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
    const method = c.claimType === 'LICENCE' ? 'scoutbox_manual_review' : (req.body?.method && ['scoutbox_manual_review', 'federation_confirmation', 'authoritative_registry'].includes(req.body.method) ? req.body.method : 'scoutbox_manual_review');
    const err = allOrNothing(() => {
      if (c.status === 'pending') { const hop = adminTransition(c, 'requires_human_review', req, { reason: 'escalated for manual decision' }); if (hop) return hop; }
      // A manual document review of a licence is labelled as exactly that — it is NOT a register check, and the display
      // copy says so.
      const display = c.claimType !== 'LICENCE' ? null : method === 'authoritative_registry'
        ? `Licence verified: ${c.metadata.licenceType}`
        : `${c.metadata.licenceType}: confirmed by Trust & Safety document review (not an independent register check)`.slice(0, L.display);
      return adminTransition(c, 'verified', req, { method, reason: reasonText(req), eventType: 'review.approved' }, {
        set: { authorityType: 'trust_safety', authorityId: 'admin' }, metadata: display ? { display } : {},
      });
    });
    if (err) return res.status(409).json({ error: err });
    if (c.subjectType === 'user') notify({ kind: 'org_user', id: c.subjectId }, 'verification', `Trust & Safety approved your ${c.claimType.replace(/_/g, ' ').toLowerCase()} verification. ✓`, c.id);
    res.json({ claim: claimById(c.id) });
  });

  adminRouter.post('/verification/claims/:id/reject', (req, res) => {
    const c = claimById(req.params.id);
    if (!c) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    if (!reasonRequired(req, res)) return;
    if (!['requires_human_review', 'automated_checks_passed', 'pending'].includes(c.status)) {
      return res.status(409).json({ error: 'CLAIM_NOT_DECIDABLE' });
    }
    const err = allOrNothing(() => {
      if (c.status === 'pending') { const hop = adminTransition(c, 'requires_human_review', req, { reason: 'escalated' }); if (hop) return hop; }
      return adminTransition(c, 'rejected', req, { reason: reasonText(req), eventType: 'review.rejected' });
    });
    if (err) return res.status(409).json({ error: err });
    if (c.subjectType === 'user') notify({ kind: 'org_user', id: c.subjectId }, 'verification', `Trust & Safety declined a verification request: ${String(req.body.reason).slice(0, 140)}`, c.id);
    res.json({ claim: claimById(c.id) });
  });

  adminRouter.post('/verification/claims/:id/request-info', (req, res) => {
    const c = claimById(req.params.id);
    if (!c) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    if (!reasonRequired(req, res)) return;
    const err = adminTransition(c, 'collecting_evidence', req, { reason: reasonText(req) });
    if (err) return res.status(409).json({ error: err });
    if (c.subjectType === 'user') notify({ kind: 'org_user', id: c.subjectId }, 'verification', `Trust & Safety needs more evidence: ${String(req.body.reason).slice(0, 140)}`, c.id);
    res.json({ claim: claimById(c.id) });
  });

  for (const [action, target] of [['suspend', 'suspended'], ['revoke', 'revoked']]) {
    adminRouter.post(`/verification/claims/:id/${action}`, (req, res) => {
      const c = claimById(req.params.id);
      if (!c) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
      if (!reasonRequired(req, res)) return;
      const err = adminTransition(c, target, req, { reason: reasonText(req), eventType: `claim.${target}` });
      if (err) return res.status(409).json({ error: err });
      if (c.subjectType === 'user') notify({ kind: 'org_user', id: c.subjectId }, 'verification', `A verification claim was ${target} by Trust & Safety: ${String(req.body.reason).slice(0, 140)}. You can dispute this.`, c.id);
      res.json({ claim: claimById(c.id), note: 'Effective badges change immediately; the historical audit trail is preserved.' });
    });
  }

  adminRouter.post('/verification/claims/:id/reinstate', (req, res) => {
    const c = claimById(req.params.id);
    if (!c) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    if (!reasonRequired(req, res)) return;
    if (!['suspended', 'revoked', 'disputed'].includes(c.status)) return res.status(409).json({ error: 'NOT_REINSTATABLE' });
    const err = adminTransition(c, 'verified', req, { method: c.verificationMethod, reason: reasonText(req), eventType: 'claim.reinstated' });
    if (err) return res.status(409).json({ error: err });
    res.json({ claim: claimById(c.id) });
  });

  // ================================================ root requests
  adminRouter.post('/verification/root-requests/:id/approve', (req, res) => {
    const r = reads.rootRequests.byId(req.params.id);
    if (!r) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
    if (!reasonRequired(req, res)) return;
    if (r.status !== 'requires_human_review') return res.status(409).json({ error: 'REQUEST_NOT_DECIDABLE', message: `Request is ${r.status}.` });
    if (!(req.body?.linkUserId === undefined || req.body?.linkUserId === null || typeof req.body.linkUserId === 'string')) return fieldInvalid(res, 'linkUserId', 'linkUserId is an account id.');
    const rev = reviewerOf(req);
    // Organisation: attach to the matched existing org, or create a new one (inside the unit below).
    const existingOrg = r.existingOrgId ? orgOf(r.existingOrgId) : null;
    // Applicant → account linking. Identity is NEVER established
    // by a name: two different people can share one. The rules:
    //  * exact match on the VERIFIED work email (mailbox control proven via
    //    the single-use token challenge) may link authoritatively;
    //  * name equality only surfaces review CANDIDATES — never a link;
    //  * where candidates exist without an email match, Trust & Safety must
    //    explicitly choose the account (linkUserId) or explicitly provision
    //    a new one (provisionNewUser: true);
    //  * with no candidates at all, the applicant is provisioned as a new
    //    user per the existing workflow — no guessing.
    const norm = (s) => String(s ?? '').trim().toLowerCase();
    const activeUsers = existingOrg ? users.forOrg(existingOrg.id, { active: true }) : [];
    const emailMatches = r.emailProved ? activeUsers.filter((u) => u.email && u.email.toLowerCase() === r.workEmail) : [];
    const nameCandidates = activeUsers.filter((u) => norm(u.name) === norm(r.applicantName) && !emailMatches.includes(u));
    let user = null;
    let identityLink = null;
    if (req.body?.linkUserId) {
      user = activeUsers.find((u) => u.id === req.body.linkUserId) ?? null;
      if (!user) return res.status(404).json({ error: 'LINK_USER_NOT_FOUND', message: 'linkUserId must be an active user of the target organisation.' });
      identityLink = 'trust_safety_selection';
    } else if (req.body?.provisionNewUser === true) {
      identityLink = 'provisioned_new_user'; // explicit human choice to NOT link
    } else if (emailMatches.length === 1) {
      user = emailMatches[0];
      identityLink = 'verified_work_email';
    } else if (emailMatches.length > 1 || nameCandidates.length > 0) {
      return res.status(409).json({
        error: 'AMBIGUOUS_APPLICANT_IDENTITY',
        message: 'Existing accounts could be the applicant. A name match never links identity automatically — choose the intended account explicitly (linkUserId) or provision a new one (provisionNewUser: true).',
        candidates: [...emailMatches, ...nameCandidates].map((u) => ({
          id: u.id, name: u.name,
          matched: emailMatches.includes(u) ? 'verified_work_email' : 'name_similarity_only',
        })),
      });
    }
    // Staff sign in by name: a new account cannot take a name an account of the organisation already has
    // (removed accounts included: product decision). Refused before anything is written.
    if (!user && existingOrg && users.byOrgAndName(existingOrg.id, r.applicantName)) {
      return res.status(409).json({ error: 'STAFF_NAME_TAKEN', message: 'An account of this organisation (current or removed) already has the applicant\'s name. Link it (linkUserId) if it is a current account and the applicant\'s; otherwise reject the request and ask the applicant to re-apply under a name that tells them apart.' });
    }
    // A work e-mail belongs to one current staff member of the organisation.
    const emailHolder = existingOrg ? users.activeByEmail(existingOrg.id, r.workEmail) : null;
    if (emailHolder && emailHolder.id !== user?.id && !user?.email) {
      return res.status(409).json({ error: 'STAFF_EMAIL_TAKEN', message: 'Another current staff member of this organisation has the applicant\'s work e-mail. Link that account (linkUserId) if it is the applicant\'s.' });
    }
    // One unit: the organisation (when it is new), the applicant's account, the claims, the verified flag, the
    // domain, the root grant and the decision commit together.
    let org = existingOrg;
    if (!user) identityLink ??= 'provisioned_new_user';
    const { approved } = unit(() => {
      if (!org) {
        // The placeholder ground and registration of a grassroots club are a known issue (docs/known-issues.md).
        org = orgs.create({
          name: r.orgName.trim(), type: r.orgType === 'agency' ? 'agency' : 'club',
          level: r.orgType === 'grassroots club' ? 'grassroots' : null,
          plan: r.orgType === 'grassroots club' ? 'Grassroots' : 'Pro',
          country: r.country.trim() || null,
          ...(r.orgType === 'grassroots club' ? { location: { lat: 51.5, lng: -0.1, city: null }, federationRef: r.federation?.trim() ? { federation: r.federation.trim(), registrationId: 'pending' } : null } : {}),
        });
      }
      if (!user) user = users.create({ orgId: org.id, name: r.applicantName.trim(), role: r.applicantRole.trim() || 'Manager', email: r.workEmail });
      else if (!user.email) user = users.update(user.id, (d) => { d.email = r.workEmail; });
      // …organisation identity claim: established by Trust & Safety review.
      createClaim({
        subjectType: 'org', subjectId: org.id, claimType: 'ORGANISATION_IDENTITY', organisationId: org.id,
        status: 'verified', verificationMethod: 'scoutbox_manual_review', verifiedAt: Date.now(),
        verifiedBy: { kind: 'trust_safety', id: rev.id }, evidenceIds: [...r.evidenceIds],
        metadata: { rootRequest: r.id, orgType: r.orgType, website: r.website },
      });
      // Keep the LEGACY effective flag in sync — same standing meaning: minors
      // still additionally need the safeguarding contract.
      orgs.update(org.id, (d) => { d.verified = true; });
      // Domain claim only where the mailbox proof aligns with the stated domain.
      if (r.emailProved && r.domain && domainCovered(domainOfEmail(r.workEmail), r.domain)) {
        if (!reads.domains.has(org.id, r.domain)) verification.domains.add(org.id, { domain: r.domain, status: 'verified', method: 'official_domain_email', verifiedAt: Date.now(), addedBy: 'root_request' });
        createClaim({
          subjectType: 'org', subjectId: org.id, claimType: 'ORGANISATION_DOMAIN', organisationId: org.id,
          status: 'verified', verificationMethod: 'official_domain_email', verifiedAt: Date.now(),
          verifiedBy: { kind: 'trust_safety', id: rev.id }, metadata: { domain: r.domain, rootRequest: r.id },
        });
      }
      // Root administrator authority + its claim.
      createClaim({
        subjectType: 'user', subjectId: user.id, claimType: 'ORGANISATION_ADMIN', organisationId: org.id,
        status: 'verified', verificationMethod: 'scoutbox_manual_review', verifiedAt: Date.now(),
        verifiedBy: { kind: 'trust_safety', id: rev.id }, metadata: { rootRequest: r.id, level: 'verification_root_admin', identityLink },
      });
      if (!reads.admins.activeFor(org.id, user.id).some((a) => a.level === 'verification_root_admin')) {
        verification.admins.create({ id: nextId('vadm'), orgId: org.id, userId: user.id, level: 'verification_root_admin', status: 'active', invitedBy: 'trust_safety', createdAt: Date.now(), acceptedAt: Date.now(), revokedAt: null, revokedBy: null });
      }
      const decided = verification.rootRequests.approve(r.id, {
        at: Date.now(), by: rev, reason: reasonText(req).slice(0, L.decisionReason), identityLink, resultOrgId: org.id, resultUserId: user.id,
      });
      verEvent('review.approved', { orgId: org.id, subjectId: user.id, after: { rootRequest: r.id, org: org.id, rootAdmin: user.id, identityLink }, reason: decided.decisionReason, actorKind: 'trust_safety', actorId: rev.id, actorName: rev.name, attribution: rev.attribution }, req);
      ctx.ledgerAppend?.({ type: 'verification_root_approved', orgId: org.id, playerId: null, detail: { request: r.id } });
      return { approved: decided };
    });
    res.json({
      request: { ...approved, applicantSecretHash: undefined }, orgId: org.id, rootAdminUserId: user.id, identityLink,
      note: 'The organisation is verified and its first root administrator is established. Staff verification is now self-service through the club. Sign-in credentials are provisioned separately (POST /admin/clubs/:id/credentials).',
    });
  });

  adminRouter.post('/verification/root-requests/:id/reject', (req, res) => {
    const r = reads.rootRequests.byId(req.params.id);
    if (!r) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
    if (!reasonRequired(req, res)) return;
    if (!['requires_human_review', 'collecting_evidence'].includes(r.status)) return res.status(409).json({ error: 'REQUEST_NOT_DECIDABLE' });
    const rev = reviewerOf(req);
    const rejected = unit(() => {
      const next = verification.rootRequests.reject(r.id, { at: Date.now(), by: rev, reason: reasonText(req).slice(0, L.decisionReason) });
      verEvent('review.rejected', { after: { rootRequest: r.id }, reason: next.decisionReason, actorKind: 'trust_safety', actorId: rev.id, actorName: rev.name, attribution: rev.attribution }, req);
      return next;
    });
    res.json({ request: { ...rejected, applicantSecretHash: undefined } });
  });

  // Appoint a root admin for an org that is ALREADY verified — a T&S action with a reason, never self-service.
  adminRouter.post('/verification/orgs/:id/appoint-root', (req, res) => {
    const org = orgOf(req.params.id);
    if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    if (!reasonRequired(req, res)) return;
    if (!org.verified) return res.status(409).json({ error: 'ORG_NOT_VERIFIED', message: 'Verify the organisation first — root authority only exists inside a verified organisation.' });
    const user = typeof req.body?.userId === 'string' ? byId.user(req.body.userId, (u) => u.orgId === org.id && !u.removedAt) : null;
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    if (reads.admins.activeFor(org.id, user.id).some((a) => a.level === 'verification_root_admin')) {
      return res.status(409).json({ error: 'ALREADY_ROOT_ADMIN' });
    }
    unit(() => {
      verification.admins.create({ id: nextId('vadm'), orgId: org.id, userId: user.id, level: 'verification_root_admin', status: 'active', invitedBy: 'trust_safety', createdAt: Date.now(), acceptedAt: Date.now(), revokedAt: null, revokedBy: null });
      createClaim({
        subjectType: 'user', subjectId: user.id, claimType: 'ORGANISATION_ADMIN', organisationId: org.id,
        status: 'verified', verificationMethod: 'scoutbox_manual_review', verifiedAt: Date.now(),
        verifiedBy: { kind: 'trust_safety', id: reviewerOf(req).id }, metadata: { appointedReason: reasonText(req).slice(0, L.appointedReason) },
      });
    });
    notify({ kind: 'org_user', id: user.id }, 'verification', `Trust & Safety appointed you root verification administrator for ${org.name}.`, org.id);
    res.status(201).json({ orgId: org.id, rootAdminUserId: user.id });
  });

  // Domain requests escalated to T&S (root/contested changes).
  adminRouter.get('/verification/domain-requests', (_req, res) => {
    res.json({ items: reads.domainRequests.awaitingReview() });
  });
  adminRouter.post('/verification/domain-requests/:id/decide', (req, res) => {
    const r = reads.domainRequests.byId(req.params.id);
    if (!r) return res.status(404).json({ error: 'DOMAIN_REQUEST_NOT_FOUND' });
    if (!reasonRequired(req, res)) return;
    if (r.status !== 'requires_human_review') return res.status(409).json({ error: 'NOT_DECIDABLE' });
    const org = orgOf(r.orgId);
    const rev = reviewerOf(req);
    const approve = req.body?.approve === true && !!org;
    const decided = unit(() => {
      if (approve) {
        if (!reads.domains.has(org.id, r.domain)) verification.domains.add(org.id, { domain: r.domain, status: 'verified', method: 'scoutbox_manual_review', verifiedAt: Date.now(), addedBy: 'trust_safety' });
        createClaim({
          subjectType: 'org', subjectId: org.id, claimType: 'ORGANISATION_DOMAIN', organisationId: org.id,
          status: 'verified', verificationMethod: 'scoutbox_manual_review', verifiedAt: Date.now(),
          verifiedBy: { kind: 'trust_safety', id: rev.id }, metadata: { domain: r.domain },
        });
        verEvent('organisation.domain_verified', { orgId: org.id, after: { domain: r.domain, via: 'trust_safety' }, reason: reasonText(req), actorKind: 'trust_safety', actorId: rev.id, actorName: rev.name, attribution: rev.attribution }, req);
      } else {
        verEvent('review.rejected', { orgId: r.orgId, after: { domainRequest: r.id }, reason: reasonText(req) });
      }
      return verification.domainRequests.decide(r.id, { approve, at: Date.now(), by: rev });
    });
    res.json({ request: decided });
  });

  // ======================================================= disputes
  adminRouter.get('/verification/disputes', (_req, res) => {
    res.json({
      items: reads.disputes.all().map((d) => ({ ...d, claim: claimById(d.claimId) ? adminClaimRow(claimById(d.claimId)) : null })),
    });
  });
  adminRouter.post('/verification/disputes/:id/resolve', (req, res) => {
    const d = reads.disputes.byId(req.params.id);
    if (!d) return res.status(404).json({ error: 'DISPUTE_NOT_FOUND' });
    if (d.status !== 'open') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    if (!reasonRequired(req, res)) return;
    const { action } = req.body ?? {}; // reinstate | revoke | correct | dismiss
    if (!['reinstate', 'revoke', 'correct', 'dismiss'].includes(action)) return fieldInvalid(res, 'action', 'action is reinstate, revoke, correct or dismiss.');
    if (!(req.body?.role === undefined || req.body?.role === null || typeof req.body.role === 'string')) return fieldInvalid(res, 'role', 'role is text.');
    if (!(req.body?.current === undefined || typeof req.body.current === 'boolean')) return fieldInvalid(res, 'current', 'current is true or false.');
    const c = claimById(d.claimId);
    // A corrected expiry is an instant or a calendar day that exists, or null; a typo is refused, not "no expiry".
    let validUntilCorrection = null;
    if (req.body?.validUntil !== undefined && !isAbsent(req.body.validUntil)) {
      const p = parseDateOrInstant(req.body.validUntil, { dayEdge: 'end' });
      if (!p.ok) return res.status(400).json({ error: 'DATE_INVALID', field: 'validUntil', message: `validUntil is a calendar day (YYYY-MM-DD) or an instant (${p.why}).`, expected: p.expected });
      validUntilCorrection = p.ms;
    }
    const period = {
      ...(req.body.validUntil !== undefined ? { validUntil: validUntilCorrection } : {}),
      ...(req.body.current !== undefined ? { current: !!req.body.current } : {}),
    };
    const corrections = { set: { ...(req.body.role ? { role: String(req.body.role).slice(0, L.role) } : {}), ...period } };
    const rev2 = reviewerOf(req);
    // One unit: the claim's outcome and the dispute's resolution commit together.
    let refusedWith = null;
    const resolved = (() => { try { return unit(() => {
      if (c && c.status === 'disputed') {
        let err = null;
        if (action === 'reinstate' || action === 'dismiss') err = adminTransition(c, 'verified', req, { method: c.verificationMethod, reason: reasonText(req), eventType: 'claim.reinstated' });
        else if (action === 'revoke') err = adminTransition(c, 'revoked', req, { reason: reasonText(req) });
        else if (action === 'correct') err = adminTransition(c, 'verified', req, { method: c.verificationMethod, reason: reasonText(req), eventType: 'claim.corrected' }, corrections);
        // A refused outcome (e.g. the person opened a new claim meanwhile) leaves the dispute open, nothing half-done.
        if (err) throw Object.assign(new Error(err), { resolveError: err });
      } else if (c && action === 'correct') {
        verification.claims.correctPeriod(c.id, period);
        verEvent('claim.corrected', { claimId: c.id, subjectId: c.subjectId, orgId: c.organisationId, reason: reasonText(req), actorKind: 'trust_safety' });
      }
      return verification.disputes.resolve(d.id, { at: Date.now(), by: rev2, resolution: `${action}: ${reasonText(req).slice(0, 300)}` });
    }); } catch (e) { if (e.resolveError) { refusedWith = e.resolveError; return null; } throw e; } })();
    if (refusedWith) return res.status(409).json({ error: refusedWith });
    if (resolved.byKind === 'org_user') notify({ kind: 'org_user', id: resolved.byId }, 'verification', `Your verification dispute was resolved: ${resolved.resolution.slice(0, 140)}`, resolved.claimId);
    res.json({ dispute: resolved, claim: c ? claimById(c.id) : null });
  });

  // =========================================== authority cascade
  adminRouter.get('/verification/authorities/:userId/claims', (req, res) => {
    res.json({
      items: reads.claims.byAuthority(req.params.userId).map(adminClaimRow),
      note: 'Claims this authority approved. Revoking an authority never silently destroys them — flag or suspend per policy after analysis.',
    });
  });
  adminRouter.post('/verification/authorities/:userId/flag', (req, res) => {
    if (!reasonRequired(req, res)) return;
    const affected = reads.claims.byAuthority(req.params.userId);
    const toSuspend = new Set(Array.isArray(req.body?.suspendClaimIds) ? req.body.suspendClaimIds : []);
    let flagged = 0, suspended = 0;
    unit(() => {
      for (const c of affected) {
        if (toSuspend.has(c.id) && c.status === 'verified') {
          const err = adminTransition(c, 'suspended', req, { reason: reasonText(req) });
          if (!err) suspended++;
        } else if (!c.metadata.flaggedForReview) {
          verification.claims.flagForReview(c.id, { at: Date.now(), reason: reasonText(req).slice(0, L.flaggedReason) });
          verEvent('review.requested', { claimId: c.id, subjectId: c.subjectId, orgId: c.organisationId, reason: 'authority cascade flag', actorKind: 'trust_safety' });
          flagged++;
        }
      }
    });
    res.json({ affected: affected.length, flagged, suspended });
  });

  // Organisation lifecycle from T&S (suspension uses the EXISTING org
  // suspension mechanics; revocation is verification-specific).
  adminRouter.post('/verification/orgs/:id/revoke', (req, res) => {
    const org = orgOf(req.params.id);
    if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    if (!reasonRequired(req, res)) return;
    unit(() => {
      orgs.update(org.id, (d) => { d.verificationRevokedAt = Date.now(); d.verified = false; }); // the effective flag follows immediately
      for (const c of reads.claims.forSubject('org', org.id)) {
        if (c.status === 'verified') adminTransition(c, 'revoked', req, { reason: reasonText(req) });
      }
      verEvent('claim.revoked', { orgId: org.id, reason: reasonText(req), actorKind: 'trust_safety', after: { organisation: 'revoked' } });
    });
    res.json({ orgId: org.id, status: ctx.orgVerificationStatus(orgOf(org.id)), note: 'Staff claims verified through this organisation stop displaying (engine re-checks at read time); their audit history is preserved.' });
  });

  // =============================================== legacy-route sync
  // The admin toggle (POST /admin/clubs/:id/verification) stays
  // functional; this hook gives its changes claim-level provenance so the two
  // systems can never drift apart.
  /** Called inside the legacy route's unit of work. */
  ctx.syncLegacyOrgVerification = (org, body) => {
    if (body?.verified === undefined) return;
    const existing = reads.claims.forSubject('org', org.id).find((c) => c.claimType === 'ORGANISATION_IDENTITY');
    if (body.verified && (!existing || existing.status !== 'verified')) {
      if (existing && ['revoked', 'suspended'].includes(existing.status)) {
        transition(existing, 'verified', { actorKind: 'trust_safety', actorName: 'Trust & Safety', method: 'scoutbox_manual_review', reason: 'legacy admin verification toggle', eventType: 'claim.reinstated' });
      } else if (!existing) {
        createClaim({
          subjectType: 'org', subjectId: org.id, claimType: 'ORGANISATION_IDENTITY', organisationId: org.id,
          status: 'verified', verificationMethod: 'scoutbox_manual_review', verifiedAt: Date.now(),
          verifiedBy: { kind: 'trust_safety', id: 'admin' }, metadata: { via: 'legacy admin route' },
        });
      }
      if (orgOf(org.id)?.verificationRevokedAt) orgs.update(org.id, (d) => { d.verificationRevokedAt = null; });
    } else if (body.verified === false && existing && existing.status === 'verified') {
      transition(existing, 'revoked', { actorKind: 'trust_safety', actorName: 'Trust & Safety', reason: 'legacy admin verification toggle removed verification' });
    }
  };

  // =============================================== deterministic sweep
  ctx.verificationSweep = () => {
    const now = Date.now();
    let changed = 0;
    // Indexed queries, not a scan of every claim; each claim's change commits as one unit with its notification.
    for (const c of reads.claims.expiredBy(now)) {
      unit(() => {
        transition(c, 'expired', { actorKind: 'system', eventType: 'claim.expired' });
        if (c.subjectType === 'user') notify({ kind: 'org_user', id: c.subjectId }, 'verification', `A verification claim expired (${c.claimType.replace(/_/g, ' ').toLowerCase()}${c.metadata?.licenceType ? `: ${c.metadata.licenceType}` : ''}). Reconfirm it from Verification.`, c.id);
      });
      changed++;
    }
    for (const c of reads.claims.warnDue(now, now + 30 * 86_400_000)) {
      unit(() => {
        verification.claims.markExpiryWarned(c.id, { at: now });
        if (c.subjectType === 'user') notify({ kind: 'org_user', id: c.subjectId }, 'verification', `A verification claim expires soon — reconfirm before ${new Date(c.validUntil).toDateString()}.`, c.id);
      });
      changed++;
    }
    return changed;
  };
}
