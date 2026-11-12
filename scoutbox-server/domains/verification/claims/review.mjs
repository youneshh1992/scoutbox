// Trust & Safety review, licence checks, disputes, cascades and the expiry sweep. A reviewer receives each case with
// the automated checks, evidence, prior claims and the reason codes that forced human review.
//
// A licence is called verified only when an authoritative source confirmed it. No governing-body registry is
// connected: providers ship `not_configured`, and only a local test fixture (env-gated) exercises the adapter.
import { declareAuditedRead } from '../../../writeRules.mjs';
import * as v from 'valibot';
import { decideReview, normalizeDomain, domainOfEmail, domainCovered, sha256 } from './shared.mjs';
import { parseDateOrInstant, isAbsent } from '../../../temporal.mjs';
import { VERIFICATION_LIMITS as L, CLAIM_TYPES } from '../../../repositories/verification.mjs';
import {
  dueDate,
  filled,
  flag,
  id,
  idList,
  inputOrRefuse,
  oneOf,
  presentOrRefuse,
  text,
} from '../../platform/schemas.mjs';

// ------------------------------------------------------------- input
const optText = (max) => v.nullish(text(max));
// The reason is required (decisionBody); each decision stores it in a column of its own size.
const reason = (max = L.reason) => optText(max);
const NewLicence = v.strictObject({
  licenceType: optText(L.licenceType),
  issuer: optText(L.issuer),
  identifier: optText(L.identifier),
  holderName: optText(L.holderName),
  issueDate: v.optional(dueDate),
  expiry: v.optional(dueDate),
  dataUrl: v.nullish(v.string()),
  filename: optText(L.filename),
});
const LicenceCheck = v.strictObject({ providerId: optText(L.provider) });
const QUEUE_STATES = ['requires_human_review', 'disputed', 'suspended'];
const QueueQuery = v.strictObject({
  orgId: v.optional(id),
  country: v.optional(text(L.country)),
  claimType: v.optional(oneOf(CLAIM_TYPES)),
  status: v.optional(oneOf(QUEUE_STATES)),
});
const Assignment = v.strictObject({ reviewer: optText(L.assignedTo) });
const Decision = v.strictObject({ reason: reason() });
const APPROVAL_METHODS = ['scoutbox_manual_review', 'federation_confirmation', 'authoritative_registry'];
const Approval = v.strictObject({ reason: reason(), method: v.optional(oneOf(APPROVAL_METHODS)) });
const RootApproval = v.strictObject({
  reason: reason(L.decisionReason),
  linkUserId: v.nullish(id),
  provisionNewUser: v.optional(flag),
});
const RootRejection = v.strictObject({ reason: reason(L.decisionReason) });
const RootAppointment = v.strictObject({ reason: reason(L.appointedReason), userId: v.nullish(id) });
const DomainDecision = v.strictObject({ reason: reason(), approve: flag });
// The resolution keeps `<action>: <reason>` in L.resolution characters.
const DisputeResolution = v.strictObject({
  reason: reason(300),
  action: oneOf(['reinstate', 'revoke', 'correct', 'dismiss']),
  role: optText(L.role),
  current: v.optional(flag),
  validUntil: v.optional(dueDate),
});
const AuthorityFlag = v.strictObject({ reason: reason(L.flaggedReason), suspendClaimIds: v.nullish(idList(500)) });

// ---------------------------------------------------------------- registry
// The interface a governing-body register integration implements. Nothing here fakes a network call.
export function licenceProviders() {
  const testState = process.env.TEST_LICENCE_REGISTRY; // '1' | 'down' | unset
  return [
    { id: 'fa-england', name: 'The FA coaching qualifications register', state: 'not_configured' },
    { id: 'uefa', name: 'UEFA coaching licence register', state: 'not_configured' },
    {
      id: 'local-test-registry',
      name: 'Local test registry (fixture — test environments only)',
      state: testState === '1' ? 'configured' : testState === 'down' ? 'temporarily_unavailable' : 'not_configured',
    },
  ];
}
// Exercises the match, ambiguous and no-match paths in tests; exists only when TEST_LICENCE_REGISTRY=1.
const TEST_REGISTRY_ROWS = [
  {
    identifier: 'UEFA-A-12345',
    holderName: 'diane okafor',
    licenceType: 'UEFA A Licence',
    issuer: 'local-test-registry',
    validUntil: '2028-06-30',
  },
  {
    identifier: 'UEFA-B-77777',
    holderName: 'sam cole',
    licenceType: 'UEFA B Licence',
    issuer: 'local-test-registry',
    validUntil: '2027-01-31',
  },
  {
    identifier: 'AMBIG-001',
    holderName: 'alex taylor',
    licenceType: 'UEFA B Licence',
    issuer: 'local-test-registry',
    validUntil: '2027-01-31',
  },
  {
    identifier: 'AMBIG-001',
    holderName: 'alexis taylor',
    licenceType: 'UEFA B Licence',
    issuer: 'local-test-registry',
    validUntil: '2026-01-31',
  },
];
export function lookupCredential({ providerId, identifier, holderName }) {
  const provider = licenceProviders().find((p) => p.id === providerId);
  if (!provider) return { state: 'unsupported', result: null };
  if (provider.state !== 'configured') return { state: provider.state, result: null };
  const rows = TEST_REGISTRY_ROWS.filter((r) => r.identifier === String(identifier ?? '').trim());
  if (!rows.length) return { state: 'configured', result: 'no_match' };
  const nameMatches = rows.filter(
    (r) =>
      r.holderName ===
      String(holderName ?? '')
        .trim()
        .toLowerCase(),
  );
  if (nameMatches.length === 1 && rows.length === 1)
    return { state: 'configured', result: 'match', record: nameMatches[0] };
  return { state: 'configured', result: 'ambiguous', candidates: rows.length };
}

export function registerVerificationReview(ctx) {
  const {
    byId,
    users,
    orgs,
    orgRouter,
    adminRouter,
    nextId,
    notify,
    verification,
    reads,
    unit,
    verEvent,
    createClaim,
    transition,
    addEvidence,
    storeEvidenceFile,
    effectiveStatus,
    vmetric,
    requireVer,
    hasVerLevel,
  } = ctx;

  const orgOf = (id) => byId.org(id) ?? null;
  const claimById = (id) => reads.claims.byId(id);
  /** The first refusal undoes them all and is returned. `announce`, when nothing was refused, writes the notices in the same unit. */
  const allOrNothing = (fn, announce) => {
    try {
      unit(() => {
        const err = fn();
        if (err) throw Object.assign(new Error(err), { transitionError: err });
        announce?.();
      });
    } catch (e) {
      if (e.transitionError) return e.transitionError;
      throw e;
    }
    return null;
  };
  // The admin surface may authenticate with one shared key, which identifies no individual. A request may declare
  // its reviewer in headers; with none declared, events say `shared_admin_key` rather than invent a person.
  const reviewerOf = (req) => {
    // An authenticated reviewer session beside the shared key wins over any header a caller typed.
    if (req?.reviewer?.id)
      return {
        id: String(req.reviewer.id).slice(0, L.id),
        name: String(req.reviewer.name ?? req.reviewer.id).slice(0, L.name),
        attribution: 'authenticated_reviewer',
      };
    const id = String(req?.headers?.['x-admin-reviewer-id'] ?? '')
      .trim()
      .slice(0, 60);
    const name = String(req?.headers?.['x-admin-reviewer-name'] ?? '')
      .trim()
      .slice(0, 80);
    return id
      ? { id, name: name || id, attribution: 'declared_reviewer' }
      : { id: 'admin', name: 'Trust & Safety', attribution: 'shared_admin_key' };
  };
  const adminTransition = (claim, to, req, opts = {}, also = {}) => {
    const rev = reviewerOf(req);
    return transition(
      claim,
      to,
      { actorKind: 'trust_safety', actorId: rev.id, actorName: rev.name, attribution: rev.attribution, ...opts },
      req,
      also,
    );
  };
  /** The body with its reason trimmed, or undefined once the 400 is sent: a manual decision always says why. */
  const decisionBody = (req, res, schema) => {
    const body = inputOrRefuse(res, schema, req.body ?? {});
    if (!body) return undefined;
    const why = filled(body.reason);
    const message = 'Manual verification decisions require a written reason — it is audited.';
    if (!presentOrRefuse(res, why, 'reason', { message })) return undefined;
    return { ...body, reason: why };
  };

  // ============================================================ licences
  orgRouter.get('/verification/licence-providers', (_req, res) => {
    res.json({
      providers: licenceProviders(),
      note: 'No production governing-body register is connected. Providers listed not_configured are real integration points, not working integrations.',
    });
  });

  orgRouter.post('/verification/licence', (req, res) => {
    const body = inputOrRefuse(res, NewLicence, req.body ?? {});
    if (!body) return;
    const { issueDate, expiry, dataUrl, filename } = body;
    const licenceType = filled(body.licenceType);
    const issuer = filled(body.issuer);
    const missing = [...(licenceType ? [] : ['licenceType']), ...(issuer ? [] : ['issuer'])];
    if (missing.length)
      return res.status(400).json({
        error: 'FIELDS_REQUIRED',
        missing,
        problem: 'required',
        message: 'licenceType and issuer are required.',
      });
    // A day-only expiry covers the whole day.
    const exp = isAbsent(expiry) ? null : parseDateOrInstant(expiry, { dayEdge: 'end' });
    const issued = isAbsent(issueDate) ? null : parseDateOrInstant(issueDate, { dayEdge: 'start' });
    if (issued && exp && !(issued.ms < exp.ms))
      return res
        .status(400)
        .json({ error: 'INTERVAL_INVALID', field: 'expiry', message: 'A licence cannot expire before it was issued.' });
    // The file is checked and stored first, so a refused file leaves no claim behind.
    let stored = null;
    if (dataUrl) {
      stored = storeEvidenceFile(dataUrl, filename, req);
      if (stored.error) return res.status(422).json({ error: stored.error });
    }
    const claim = unit(() => {
      const created = createClaim(
        {
          subjectType: 'user',
          subjectId: req.orgUser.id,
          claimType: 'LICENCE',
          organisationId: null,
          status: 'collecting_evidence',
          verificationMethod: 'document_submitted',
          validFrom: issued ? issued.ms : null,
          validUntil: exp ? exp.ms : null,
          metadata: {
            licenceType,
            issuer,
            identifier: filled(body.identifier),
            // The account's name, which no schema has read, may be longer than a holder name.
            holderName: filled(body.holderName) ?? String(req.orgUser.name ?? '').slice(0, L.holderName),
            display: 'Credential submitted — verification pending', // never "Licence verified" from an upload
          },
        },
        req,
      );
      if (stored) {
        addEvidence(
          {
            type: 'document',
            source: 'subject_upload',
            suppliedByKind: 'org_user',
            suppliedById: req.orgUser.id,
            orgId: req.org.id,
            claimIds: [created.id],
            ...stored,
            visibility: 'trust_and_safety',
          },
          req,
        );
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
    if (!['collecting_evidence', 'pending'].includes(claim.status))
      return res.status(409).json({ error: 'ALREADY_SUBMITTED' });
    const body = inputOrRefuse(res, LicenceCheck, req.body ?? {});
    if (!body) return;
    // The register is asked before anything is written; its answer and the claim's moves then commit together.
    const providerId = body.providerId ?? 'local-test-registry';
    const lookup = lookupCredential({
      providerId,
      identifier: claim.metadata.identifier,
      holderName: String(claim.metadata.holderName ?? '').toLowerCase(),
    });
    const view = () => {
      const c = reads.claims.byId(claim.id);
      return { id: c.id, status: c.status, display: c.metadata.display };
    };
    const toReview = (reason, extra) =>
      transition(claim, 'requires_human_review', { actorKind: 'system', reason }, req, extra);
    let answer = null;
    const err = allOrNothing(() => {
      if (claim.status === 'collecting_evidence') {
        const moved = transition(claim, 'pending', { actorKind: 'org_user', actorId: req.orgUser.id }, req);
        if (moved) return moved;
      }
      verEvent(
        lookup.result ? 'automated_check.passed' : 'automated_check.failed',
        {
          claimId: claim.id,
          subjectId: claim.subjectId,
          after: { provider: providerId, state: lookup.state, result: lookup.result },
        },
        req,
      );
      if (lookup.state !== 'configured') {
        // An unavailable or unconfigured provider leaves the claim pending, neither verified nor rejected.
        const registry = { provider: providerId, state: lookup.state, checkedAt: Date.now() };
        const routed = toReview('no authoritative register available', {
          metadata: { registry },
          addReviewReasons: ['NO_AUTHORITATIVE_SOURCE', 'DOCUMENT_AUTHENTICITY_UNCONFIRMED'],
        });
        answer = {
          routedToReview: true,
          provider: { id: providerId, state: lookup.state },
          note:
            lookup.state === 'temporarily_unavailable'
              ? 'Verification provider unavailable — verification remains pending.'
              : 'No authoritative register is configured for this issuer — a reviewer can perform a document review, which is labelled as a document review.',
          routed: routed ? null : 'requires_human_review',
        };
        return null;
      }
      if (lookup.result === 'match') {
        const rec = lookup.record;
        // The self-declared expiry never stands in for an unreadable register one.
        const regUntil = isAbsent(rec.validUntil) ? null : parseDateOrInstant(rec.validUntil, { dayEdge: 'end' });
        if (regUntil && !regUntil.ok) {
          const registry = {
            provider: providerId,
            result: 'unreadable_record',
            checkedAt: Date.now(),
            reference: rec.identifier,
          };
          toReview('registry record carried an unreadable expiry', {
            metadata: { registry },
            addReviewReasons: ['REGISTRY_RECORD_UNREADABLE'],
          });
          answer = {
            routedToReview: true,
            provider: { id: providerId, result: 'unreadable_record' },
            note: 'The register matched but its expiry date could not be read. Nothing is verified from a record that cannot be dated; a reviewer decides.',
          };
          return null;
        }
        addEvidence(
          {
            type: 'registry_result',
            source: providerId,
            suppliedByKind: 'system',
            suppliedById: null,
            orgId: req.org.id,
            claimIds: [claim.id],
            visibility: 'trust_and_safety',
            meta: { identifier: rec.identifier, licenceType: rec.licenceType, validUntil: rec.validUntil },
          },
          req,
        );
        const registry = { provider: providerId, result: 'match', checkedAt: Date.now(), reference: rec.identifier };
        answer = { provider: { id: providerId, result: 'match' } };
        return (
          transition(claim, 'automated_checks_passed', { actorKind: 'system' }, req, {
            set: regUntil ? { validUntil: regUntil.ms } : {},
            metadata: { display: `Licence verified: ${rec.licenceType}`, registry },
          }) ??
          transition(
            claim,
            'verified',
            { actorKind: 'system', method: 'authoritative_registry', eventType: 'claim.verified' },
            req,
          )
        );
      }
      if (lookup.result === 'ambiguous') {
        toReview('registry returned an ambiguous match', { addReviewReasons: ['REGISTRY_AMBIGUOUS_MATCH'] });
        answer = {
          routedToReview: true,
          provider: { id: providerId, result: 'ambiguous' },
          note: 'The register returned more than one plausible record — a human resolves ambiguity, never a guess.',
        };
        return null;
      }
      // No record verifies nothing and proves nothing.
      const registry = { provider: providerId, result: 'no_match', checkedAt: Date.now() };
      toReview('registry found no matching record', {
        metadata: { registry },
        addReviewReasons: ['DOCUMENT_AUTHENTICITY_UNCONFIRMED'],
      });
      answer = {
        routedToReview: true,
        provider: { id: providerId, result: 'no_match' },
        note: 'No register record matched. The credential stays unverified; a reviewer can examine the evidence.',
      };
      return null;
    });
    if (err) return res.status(409).json({ error: err });
    const { routedToReview, ...rest } = answer;
    if (routedToReview) vmetric('routedToHumanReview');
    res.json({ claim: view(), ...rest });
  });

  // ================================================= evidence access
  // T&S sees everything, every read logged; org reviewers see their own org's organisation_internal evidence only.
  adminRouter.get('/verification/evidence/:id', (req, res) => {
    const ev = reads.evidence.byId(req.params.id);
    if (!ev) return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    declareAuditedRead('every read of verification evidence is logged');
    verEvent('evidence.accessed', {
      claimId: ev.claimIds[0] ?? null,
      subjectId: ev.suppliedById,
      orgId: ev.orgId,
      after: { evidenceId: ev.id, by: 'trust_safety' },
    });
    const blob = ev.mediaId ? ctx.storage.read(ev.mediaId) : null;
    res.json({ evidence: ev, file: blob ? { mime: blob.contentType, base64: blob.buffer.toString('base64') } : null });
  });
  orgRouter.get('/verification/evidence/:id', (req, res) => {
    const ev = reads.evidence.byId(req.params.id);
    if (!ev || ev.orgId !== req.org.id || ev.visibility !== 'organisation_internal') {
      return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
    }
    if (!requireVer(req, res, 'verification_reviewer')) return;
    verEvent(
      'evidence.accessed',
      { subjectId: ev.suppliedById, orgId: ev.orgId, after: { evidenceId: ev.id, by: req.orgUser.id } },
      req,
    );
    res.json({ evidence: { ...ev, mediaId: undefined } });
  });

  // ==================================================== T&S review queue
  adminRouter.get('/verification/queue', (req, res) => {
    const query = inputOrRefuse(res, QueueQuery, req.query ?? {}, { root: 'query' });
    if (!query) return;
    const now = Date.now();
    const claims = reads.claims.inStatuses(query.status ? [query.status] : QUEUE_STATES, {
      orgId: query.orgId ?? null,
      claimType: query.claimType ?? null,
    });
    const roots = reads.rootRequests.awaitingReview(query.country ?? null);
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
      id: c.id,
      claimType: c.claimType,
      status: c.status,
      role: c.role,
      subject: { type: c.subjectType, id: c.subjectId, name: subject?.name ?? '(unknown)' },
      organisation: org ? { id: org.id, name: org.name, status: ctx.orgVerificationStatus(org) } : null,
      reviewReasons: c.reviewReasons,
      riskFlags: c.riskFlags,
      assignedTo: c.metadata?.assignedTo ?? null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      disputedAt: c.disputedAt,
    };
  }

  adminRouter.get('/verification/cases/:id', (req, res) => {
    const c = claimById(req.params.id);
    if (!c) return res.status(404).json({ error: 'CASE_NOT_FOUND' });
    const subjectUser = c.subjectType === 'user' ? byId.user(c.subjectId) : null;
    res.json({
      claim: c,
      row: adminClaimRow(c),
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
    const body = inputOrRefuse(res, Assignment, req.body ?? {});
    if (!body) return;
    const assignedTo = filled(body.reviewer) ?? 'Trust & Safety';
    unit(() => {
      verification.claims.assign(c.id, { assignedTo });
      verEvent('review.assigned', { claimId: c.id, after: { reviewer: assignedTo } });
    });
    res.json({ assigned: assignedTo });
  });

  adminRouter.post('/verification/claims/:id/approve', (req, res) => {
    const c = claimById(req.params.id);
    if (!c) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    const body = decisionBody(req, res, Approval);
    if (!body) return;
    if (!['requires_human_review', 'automated_checks_passed', 'pending'].includes(c.status)) {
      return res.status(409).json({ error: 'CLAIM_NOT_DECIDABLE', message: `Claim is ${c.status}.` });
    }
    // A licence is only ever verified by a register through the licence check, never by a reviewer naming one.
    const method = c.claimType === 'LICENCE' ? 'scoutbox_manual_review' : (body.method ?? 'scoutbox_manual_review');
    const err = allOrNothing(
      () => {
        if (c.status === 'pending') {
          const hop = adminTransition(c, 'requires_human_review', req, { reason: 'escalated for manual decision' });
          if (hop) return hop;
        }
        // A manual document review of a licence is not a register check, and the display copy says so.
        const display =
          c.claimType !== 'LICENCE'
            ? null
            : method === 'authoritative_registry'
              ? `Licence verified: ${c.metadata.licenceType}`
              : `${c.metadata.licenceType}: confirmed by Trust & Safety document review (not an independent register check)`.slice(
                  0,
                  L.display,
                );
        return adminTransition(
          c,
          'verified',
          req,
          { method, reason: body.reason, eventType: 'review.approved' },
          {
            set: { authorityType: 'trust_safety', authorityId: 'admin' },
            metadata: display ? { display } : {},
          },
        );
      },
      () => {
        if (c.subjectType === 'user')
          notify(
            { kind: 'org_user', id: c.subjectId },
            'verification',
            `Trust & Safety approved your ${c.claimType.replace(/_/g, ' ').toLowerCase()} verification. ✓`,
            c.id,
          );
      },
    );
    if (err) return res.status(409).json({ error: err });
    res.json({ claim: claimById(c.id) });
  });

  adminRouter.post('/verification/claims/:id/reject', (req, res) => {
    const c = claimById(req.params.id);
    if (!c) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    const body = decisionBody(req, res, Decision);
    if (!body) return;
    if (!['requires_human_review', 'automated_checks_passed', 'pending'].includes(c.status)) {
      return res.status(409).json({ error: 'CLAIM_NOT_DECIDABLE' });
    }
    const err = allOrNothing(
      () => {
        if (c.status === 'pending') {
          const hop = adminTransition(c, 'requires_human_review', req, { reason: 'escalated' });
          if (hop) return hop;
        }
        return adminTransition(c, 'rejected', req, { reason: body.reason, eventType: 'review.rejected' });
      },
      () => {
        if (c.subjectType === 'user')
          notify(
            { kind: 'org_user', id: c.subjectId },
            'verification',
            `Trust & Safety declined a verification request: ${body.reason.slice(0, 140)}`,
            c.id,
          );
      },
    );
    if (err) return res.status(409).json({ error: err });
    res.json({ claim: claimById(c.id) });
  });

  adminRouter.post('/verification/claims/:id/request-info', (req, res) => {
    const c = claimById(req.params.id);
    if (!c) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    const body = decisionBody(req, res, Decision);
    if (!body) return;
    const err = allOrNothing(
      () => adminTransition(c, 'collecting_evidence', req, { reason: body.reason }),
      () => {
        if (c.subjectType === 'user')
          notify(
            { kind: 'org_user', id: c.subjectId },
            'verification',
            `Trust & Safety needs more evidence: ${body.reason.slice(0, 140)}`,
            c.id,
          );
      },
    );
    if (err) return res.status(409).json({ error: err });
    res.json({ claim: claimById(c.id) });
  });

  for (const [action, target] of [
    ['suspend', 'suspended'],
    ['revoke', 'revoked'],
  ]) {
    adminRouter.post(`/verification/claims/:id/${action}`, (req, res) => {
      const c = claimById(req.params.id);
      if (!c) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
      const body = decisionBody(req, res, Decision);
      if (!body) return;
      const err = allOrNothing(
        () => adminTransition(c, target, req, { reason: body.reason, eventType: `claim.${target}` }),
        () => {
          if (c.subjectType === 'user')
            notify(
              { kind: 'org_user', id: c.subjectId },
              'verification',
              `A verification claim was ${target} by Trust & Safety: ${body.reason.slice(0, 140)}. You can dispute this.`,
              c.id,
            );
        },
      );
      if (err) return res.status(409).json({ error: err });
      res.json({
        claim: claimById(c.id),
        note: 'Effective badges change immediately; the historical audit trail is preserved.',
      });
    });
  }

  adminRouter.post('/verification/claims/:id/reinstate', (req, res) => {
    const c = claimById(req.params.id);
    if (!c) return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    const body = decisionBody(req, res, Decision);
    if (!body) return;
    if (!['suspended', 'revoked', 'disputed'].includes(c.status))
      return res.status(409).json({ error: 'NOT_REINSTATABLE' });
    const err = adminTransition(c, 'verified', req, {
      method: c.verificationMethod,
      reason: body.reason,
      eventType: 'claim.reinstated',
    });
    if (err) return res.status(409).json({ error: err });
    res.json({ claim: claimById(c.id) });
  });

  // ================================================ root requests
  adminRouter.post('/verification/root-requests/:id/approve', (req, res) => {
    const r = reads.rootRequests.byId(req.params.id);
    if (!r) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
    const body = decisionBody(req, res, RootApproval);
    if (!body) return;
    if (r.status !== 'requires_human_review')
      return res.status(409).json({ error: 'REQUEST_NOT_DECIDABLE', message: `Request is ${r.status}.` });
    const rev = reviewerOf(req);
    const existingOrg = r.existingOrgId ? orgOf(r.existingOrgId) : null;
    // Identity is never established by a name: two people can share one. Only a match on the proven work e-mail
    // links; a name match only surfaces candidates, and T&S must then choose an account or provision a new one.
    const norm = (s) =>
      String(s ?? '')
        .trim()
        .toLowerCase();
    const activeUsers = existingOrg ? users.forOrg(existingOrg.id, { active: true }) : [];
    const emailMatches = r.emailProved
      ? activeUsers.filter((u) => u.email && u.email.toLowerCase() === r.workEmail)
      : [];
    const nameCandidates = activeUsers.filter(
      (u) => norm(u.name) === norm(r.applicantName) && !emailMatches.includes(u),
    );
    let user = null;
    let identityLink = null;
    if (body.linkUserId) {
      user = activeUsers.find((u) => u.id === body.linkUserId) ?? null;
      if (!user)
        return res.status(404).json({
          error: 'LINK_USER_NOT_FOUND',
          message: 'linkUserId must be an active user of the target organisation.',
        });
      identityLink = 'trust_safety_selection';
    } else if (body.provisionNewUser === true) {
      identityLink = 'provisioned_new_user'; // an explicit choice not to link
    } else if (emailMatches.length === 1) {
      user = emailMatches[0];
      identityLink = 'verified_work_email';
    } else if (emailMatches.length > 1 || nameCandidates.length > 0) {
      return res.status(409).json({
        error: 'AMBIGUOUS_APPLICANT_IDENTITY',
        message:
          'Existing accounts could be the applicant. A name match never links identity automatically — choose the intended account explicitly (linkUserId) or provision a new one (provisionNewUser: true).',
        candidates: [...emailMatches, ...nameCandidates].map((u) => ({
          id: u.id,
          name: u.name,
          matched: emailMatches.includes(u) ? 'verified_work_email' : 'name_similarity_only',
        })),
      });
    }
    // Staff sign in by name, so a new account cannot take a name an account of the organisation already has (removed
    // accounts included: a product decision).
    if (!user && existingOrg && users.byOrgAndName(existingOrg.id, r.applicantName)) {
      return res.status(409).json({
        error: 'STAFF_NAME_TAKEN',
        message:
          "An account of this organisation (current or removed) already has the applicant's name. Link it (linkUserId) if it is a current account and the applicant's; otherwise reject the request and ask the applicant to re-apply under a name that tells them apart.",
      });
    }
    // A work e-mail belongs to one current staff member of the organisation.
    const emailHolder = existingOrg ? users.activeByEmail(existingOrg.id, r.workEmail) : null;
    if (emailHolder && emailHolder.id !== user?.id && !user?.email) {
      return res.status(409).json({
        error: 'STAFF_EMAIL_TAKEN',
        message:
          "Another current staff member of this organisation has the applicant's work e-mail. Link that account (linkUserId) if it is the applicant's.",
      });
    }
    let org = existingOrg;
    if (!user) identityLink ??= 'provisioned_new_user';
    const { approved } = unit(() => {
      if (!org) {
        // The placeholder ground and registration of a grassroots club are a known issue (docs/known-issues.md).
        org = orgs.create({
          name: r.orgName.trim(),
          type: r.orgType === 'agency' ? 'agency' : 'club',
          level: r.orgType === 'grassroots club' ? 'grassroots' : null,
          plan: r.orgType === 'grassroots club' ? 'Grassroots' : 'Pro',
          country: r.country.trim() || null,
          ...(r.orgType === 'grassroots club'
            ? {
                location: { lat: 51.5, lng: -0.1, city: null },
                federationRef: r.federation?.trim()
                  ? { federation: r.federation.trim(), registrationId: 'pending' }
                  : null,
              }
            : {}),
        });
      }
      if (!user)
        user = users.create({
          orgId: org.id,
          name: r.applicantName.trim(),
          role: r.applicantRole.trim() || 'Manager',
          email: r.workEmail,
        });
      else if (!user.email) user = users.setEmail(user.id, r.workEmail);
      createClaim({
        subjectType: 'org',
        subjectId: org.id,
        claimType: 'ORGANISATION_IDENTITY',
        organisationId: org.id,
        status: 'verified',
        verificationMethod: 'scoutbox_manual_review',
        verifiedAt: Date.now(),
        verifiedBy: { kind: 'trust_safety', id: rev.id },
        evidenceIds: [...r.evidenceIds],
        metadata: { rootRequest: r.id, orgType: r.orgType, website: r.website },
      });
      // Minors still also need the safeguarding contract.
      orgs.setStanding(org.id, { verified: true });
      // Domain claim only where the mailbox proof aligns with the stated domain.
      if (r.emailProved && r.domain && domainCovered(domainOfEmail(r.workEmail), r.domain)) {
        if (!reads.domains.has(org.id, r.domain))
          verification.domains.add(org.id, {
            domain: r.domain,
            status: 'verified',
            method: 'official_domain_email',
            verifiedAt: Date.now(),
            addedBy: 'root_request',
          });
        createClaim({
          subjectType: 'org',
          subjectId: org.id,
          claimType: 'ORGANISATION_DOMAIN',
          organisationId: org.id,
          status: 'verified',
          verificationMethod: 'official_domain_email',
          verifiedAt: Date.now(),
          verifiedBy: { kind: 'trust_safety', id: rev.id },
          metadata: { domain: r.domain, rootRequest: r.id },
        });
      }
      createClaim({
        subjectType: 'user',
        subjectId: user.id,
        claimType: 'ORGANISATION_ADMIN',
        organisationId: org.id,
        status: 'verified',
        verificationMethod: 'scoutbox_manual_review',
        verifiedAt: Date.now(),
        verifiedBy: { kind: 'trust_safety', id: rev.id },
        metadata: { rootRequest: r.id, level: 'verification_root_admin', identityLink },
      });
      if (!reads.admins.activeFor(org.id, user.id).some((a) => a.level === 'verification_root_admin')) {
        verification.admins.create({
          id: nextId('vadm'),
          orgId: org.id,
          userId: user.id,
          level: 'verification_root_admin',
          status: 'active',
          invitedBy: 'trust_safety',
          createdAt: Date.now(),
          acceptedAt: Date.now(),
          revokedAt: null,
          revokedBy: null,
        });
      }
      const decided = verification.rootRequests.approve(r.id, {
        at: Date.now(),
        by: rev,
        reason: body.reason,
        identityLink,
        resultOrgId: org.id,
        resultUserId: user.id,
      });
      verEvent(
        'review.approved',
        {
          orgId: org.id,
          subjectId: user.id,
          after: { rootRequest: r.id, org: org.id, rootAdmin: user.id, identityLink },
          reason: decided.decisionReason,
          actorKind: 'trust_safety',
          actorId: rev.id,
          actorName: rev.name,
          attribution: rev.attribution,
        },
        req,
      );
      ctx.ledgerAppend?.({
        type: 'verification_root_approved',
        orgId: org.id,
        playerId: null,
        detail: { request: r.id },
      });
      return { approved: decided };
    });
    res.json({
      request: { ...approved, applicantSecretHash: undefined },
      orgId: org.id,
      rootAdminUserId: user.id,
      identityLink,
      note: 'The organisation is verified and its first root administrator is established. Staff verification is now self-service through the club. Sign-in credentials are provisioned separately (POST /admin/clubs/:id/credentials).',
    });
  });

  adminRouter.post('/verification/root-requests/:id/reject', (req, res) => {
    const r = reads.rootRequests.byId(req.params.id);
    if (!r) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
    const body = decisionBody(req, res, RootRejection);
    if (!body) return;
    if (!['requires_human_review', 'collecting_evidence'].includes(r.status))
      return res.status(409).json({ error: 'REQUEST_NOT_DECIDABLE' });
    const rev = reviewerOf(req);
    const rejected = unit(() => {
      const next = verification.rootRequests.reject(r.id, {
        at: Date.now(),
        by: rev,
        reason: body.reason,
      });
      verEvent(
        'review.rejected',
        {
          after: { rootRequest: r.id },
          reason: next.decisionReason,
          actorKind: 'trust_safety',
          actorId: rev.id,
          actorName: rev.name,
          attribution: rev.attribution,
        },
        req,
      );
      return next;
    });
    res.json({ request: { ...rejected, applicantSecretHash: undefined } });
  });

  // A T&S action with a reason, never self-service.
  adminRouter.post('/verification/orgs/:id/appoint-root', (req, res) => {
    const org = orgOf(req.params.id);
    if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    const body = decisionBody(req, res, RootAppointment);
    if (!body) return;
    if (!org.verified)
      return res.status(409).json({
        error: 'ORG_NOT_VERIFIED',
        message: 'Verify the organisation first — root authority only exists inside a verified organisation.',
      });
    const user = body.userId ? byId.user(body.userId, (u) => u.orgId === org.id && !u.removedAt) : null;
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    if (reads.admins.activeFor(org.id, user.id).some((a) => a.level === 'verification_root_admin')) {
      return res.status(409).json({ error: 'ALREADY_ROOT_ADMIN' });
    }
    unit(() => {
      verification.admins.create({
        id: nextId('vadm'),
        orgId: org.id,
        userId: user.id,
        level: 'verification_root_admin',
        status: 'active',
        invitedBy: 'trust_safety',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        revokedAt: null,
        revokedBy: null,
      });
      createClaim({
        subjectType: 'user',
        subjectId: user.id,
        claimType: 'ORGANISATION_ADMIN',
        organisationId: org.id,
        status: 'verified',
        verificationMethod: 'scoutbox_manual_review',
        verifiedAt: Date.now(),
        verifiedBy: { kind: 'trust_safety', id: reviewerOf(req).id },
        metadata: { appointedReason: body.reason },
      });
      notify(
        { kind: 'org_user', id: user.id },
        'verification',
        `Trust & Safety appointed you root verification administrator for ${org.name}.`,
        org.id,
      );
    });
    res.status(201).json({ orgId: org.id, rootAdminUserId: user.id });
  });

  // Domain requests escalated to T&S (root or contested changes).
  adminRouter.get('/verification/domain-requests', (_req, res) => {
    res.json({ items: reads.domainRequests.awaitingReview() });
  });
  adminRouter.post('/verification/domain-requests/:id/decide', (req, res) => {
    const r = reads.domainRequests.byId(req.params.id);
    if (!r) return res.status(404).json({ error: 'DOMAIN_REQUEST_NOT_FOUND' });
    const body = decisionBody(req, res, DomainDecision);
    if (!body) return;
    if (r.status !== 'requires_human_review') return res.status(409).json({ error: 'NOT_DECIDABLE' });
    const org = orgOf(r.orgId);
    const rev = reviewerOf(req);
    const approve = body.approve && !!org;
    const decided = unit(() => {
      if (approve) {
        if (!reads.domains.has(org.id, r.domain))
          verification.domains.add(org.id, {
            domain: r.domain,
            status: 'verified',
            method: 'scoutbox_manual_review',
            verifiedAt: Date.now(),
            addedBy: 'trust_safety',
          });
        createClaim({
          subjectType: 'org',
          subjectId: org.id,
          claimType: 'ORGANISATION_DOMAIN',
          organisationId: org.id,
          status: 'verified',
          verificationMethod: 'scoutbox_manual_review',
          verifiedAt: Date.now(),
          verifiedBy: { kind: 'trust_safety', id: rev.id },
          metadata: { domain: r.domain },
        });
        verEvent(
          'organisation.domain_verified',
          {
            orgId: org.id,
            after: { domain: r.domain, via: 'trust_safety' },
            reason: body.reason,
            actorKind: 'trust_safety',
            actorId: rev.id,
            actorName: rev.name,
            attribution: rev.attribution,
          },
          req,
        );
      } else {
        verEvent('review.rejected', { orgId: r.orgId, after: { domainRequest: r.id }, reason: body.reason });
      }
      return verification.domainRequests.decide(r.id, { approve, at: Date.now(), by: rev });
    });
    res.json({ request: decided });
  });

  // ======================================================= disputes
  adminRouter.get('/verification/disputes', (_req, res) => {
    res.json({
      items: reads.disputes
        .all()
        .map((d) => ({ ...d, claim: claimById(d.claimId) ? adminClaimRow(claimById(d.claimId)) : null })),
    });
  });
  adminRouter.post('/verification/disputes/:id/resolve', (req, res) => {
    const d = reads.disputes.byId(req.params.id);
    if (!d) return res.status(404).json({ error: 'DISPUTE_NOT_FOUND' });
    if (d.status !== 'open') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    const body = decisionBody(req, res, DisputeResolution);
    if (!body) return;
    const { action } = body;
    const c = claimById(d.claimId);
    // Sent as null or '', the expiry is cleared.
    const period = {
      ...(body.validUntil !== undefined
        ? {
            validUntil: isAbsent(body.validUntil) ? null : parseDateOrInstant(body.validUntil, { dayEdge: 'end' }).ms,
          }
        : {}),
      ...(body.current !== undefined ? { current: body.current } : {}),
    };
    const role = filled(body.role);
    const corrections = { set: { ...(role ? { role } : {}), ...period } };
    const rev2 = reviewerOf(req);
    let refusedWith = null;
    const resolved = (() => {
      try {
        return unit(() => {
          if (c && c.status === 'disputed') {
            let err = null;
            if (action === 'reinstate' || action === 'dismiss')
              err = adminTransition(c, 'verified', req, {
                method: c.verificationMethod,
                reason: body.reason,
                eventType: 'claim.reinstated',
              });
            else if (action === 'revoke') err = adminTransition(c, 'revoked', req, { reason: body.reason });
            else if (action === 'correct')
              err = adminTransition(
                c,
                'verified',
                req,
                { method: c.verificationMethod, reason: body.reason, eventType: 'claim.corrected' },
                corrections,
              );
            // A refused outcome (e.g. the person opened a new claim meanwhile) leaves the dispute open, nothing half-done.
            if (err) throw Object.assign(new Error(err), { resolveError: err });
          } else if (c && action === 'correct') {
            verification.claims.correctPeriod(c.id, period);
            verEvent('claim.corrected', {
              claimId: c.id,
              subjectId: c.subjectId,
              orgId: c.organisationId,
              reason: body.reason,
              actorKind: 'trust_safety',
            });
          }
          const done = verification.disputes.resolve(d.id, {
            at: Date.now(),
            by: rev2,
            resolution: `${action}: ${body.reason}`,
          });
          if (done.byKind === 'org_user')
            notify(
              { kind: 'org_user', id: done.byId },
              'verification',
              `Your verification dispute was resolved: ${done.resolution.slice(0, 140)}`,
              done.claimId,
            );
          return done;
        });
      } catch (e) {
        if (e.resolveError) {
          refusedWith = e.resolveError;
          return null;
        }
        throw e;
      }
    })();
    if (refusedWith) return res.status(409).json({ error: refusedWith });
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
    const body = decisionBody(req, res, AuthorityFlag);
    if (!body) return;
    const affected = reads.claims.byAuthority(req.params.userId);
    const toSuspend = new Set(body.suspendClaimIds ?? []);
    let flagged = 0,
      suspended = 0;
    unit(() => {
      for (const c of affected) {
        if (toSuspend.has(c.id) && c.status === 'verified') {
          const err = adminTransition(c, 'suspended', req, { reason: body.reason });
          if (!err) suspended++;
        } else if (!c.metadata.flaggedForReview) {
          verification.claims.flagForReview(c.id, {
            at: Date.now(),
            reason: body.reason,
          });
          verEvent('review.requested', {
            claimId: c.id,
            subjectId: c.subjectId,
            orgId: c.organisationId,
            reason: 'authority cascade flag',
            actorKind: 'trust_safety',
          });
          flagged++;
        }
      }
    });
    res.json({ affected: affected.length, flagged, suspended });
  });

  // Suspension uses the ordinary org suspension; revocation is verification-specific.
  adminRouter.post('/verification/orgs/:id/revoke', (req, res) => {
    const org = orgOf(req.params.id);
    if (!org) return res.status(404).json({ error: 'ORG_NOT_FOUND' });
    const body = decisionBody(req, res, Decision);
    if (!body) return;
    unit(() => {
      orgs.revokeVerification(org.id, Date.now()); // the effective flag follows immediately
      for (const c of reads.claims.forSubject('org', org.id)) {
        if (c.status === 'verified') adminTransition(c, 'revoked', req, { reason: body.reason });
      }
      verEvent('claim.revoked', {
        orgId: org.id,
        reason: body.reason,
        actorKind: 'trust_safety',
        after: { organisation: 'revoked' },
      });
    });
    res.json({
      orgId: org.id,
      status: ctx.orgVerificationStatus(orgOf(org.id)),
      note: 'Staff claims verified through this organisation stop displaying (engine re-checks at read time); their audit history is preserved.',
    });
  });

  // =============================================== legacy-route sync
  /** Gives the admin toggle (POST /admin/clubs/:id/verification) claim-level provenance; runs inside its unit. */
  ctx.syncLegacyOrgVerification = (org, body) => {
    if (body?.verified === undefined) return;
    const existing = reads.claims.forSubject('org', org.id).find((c) => c.claimType === 'ORGANISATION_IDENTITY');
    if (body.verified && (!existing || existing.status !== 'verified')) {
      if (existing && ['revoked', 'suspended'].includes(existing.status)) {
        transition(existing, 'verified', {
          actorKind: 'trust_safety',
          actorName: 'Trust & Safety',
          method: 'scoutbox_manual_review',
          reason: 'legacy admin verification toggle',
          eventType: 'claim.reinstated',
        });
      } else if (!existing) {
        createClaim({
          subjectType: 'org',
          subjectId: org.id,
          claimType: 'ORGANISATION_IDENTITY',
          organisationId: org.id,
          status: 'verified',
          verificationMethod: 'scoutbox_manual_review',
          verifiedAt: Date.now(),
          verifiedBy: { kind: 'trust_safety', id: 'admin' },
          metadata: { via: 'legacy admin route' },
        });
      }
      if (orgOf(org.id)?.verificationRevokedAt) orgs.clearVerificationRevocation(org.id);
    } else if (body.verified === false && existing && existing.status === 'verified') {
      transition(existing, 'revoked', {
        actorKind: 'trust_safety',
        actorName: 'Trust & Safety',
        reason: 'legacy admin verification toggle removed verification',
      });
    }
  };

  // =============================================== expiry sweep
  ctx.verificationSweep = () => {
    const now = Date.now();
    let changed = 0;
    for (const c of reads.claims.expiredBy(now)) {
      unit(() => {
        transition(c, 'expired', { actorKind: 'system', eventType: 'claim.expired' });
        if (c.subjectType === 'user')
          notify(
            { kind: 'org_user', id: c.subjectId },
            'verification',
            `A verification claim expired (${c.claimType.replace(/_/g, ' ').toLowerCase()}${c.metadata?.licenceType ? `: ${c.metadata.licenceType}` : ''}). Reconfirm it from Verification.`,
            c.id,
          );
      });
      changed++;
    }
    for (const c of reads.claims.warnDue(now, now + 30 * 86_400_000)) {
      unit(() => {
        verification.claims.markExpiryWarned(c.id, { at: now });
        if (c.subjectType === 'user')
          notify(
            { kind: 'org_user', id: c.subjectId },
            'verification',
            `A verification claim expires soon — reconfirm before ${new Date(c.validUntil).toDateString()}.`,
            c.id,
          );
      });
      changed++;
    }
    return changed;
  };
}
