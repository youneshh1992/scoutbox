// The verification rules behind the organisations-and-staff battery (e2e/verification/organisationsAndStaff.mjs),
// checked in this process: the claim state machine, the effective engine, the decision engine and risk flags, the
// email, domain, evidence and token primitives, and the safe public projector.
import {
  applyTransition,
  canTransition,
  effectiveStatus,
  decideReview,
  riskFlags,
  emailProblem,
  domainOfEmail,
  isFreeMail,
  isDisposable,
  domainCovered,
  normalizeDomain,
  evidenceFileProblem,
  evidenceCompleteness,
  mintToken,
  consumeToken,
  toPublicVerificationProfile,
  verLevelFor,
  orgVerificationStatus,
  arrayTokenStore,
} from '../../../domains/verification/claims/shared.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, section, done } = rulesSuite('verification/organisationsAndStaff');

section('unit fixtures — state machine');
{
  const mk = (status, extra = {}) => ({
    id: 'c1',
    subjectType: 'user',
    subjectId: 'u1',
    claimType: 'CLUB_ROLE',
    organisationId: 'o1',
    status,
    current: true,
    validFrom: null,
    validUntil: null,
    verificationMethod: null,
    metadata: {},
    riskFlags: [],
    reviewReasons: [],
    evidenceIds: [],
    ...extra,
  });
  ok(
    canTransition('pending', 'automated_checks_passed') && !canTransition('pending', 'verified'),
    'pending can never jump straight to verified',
  );
  ok(
    !canTransition('unverified', 'verified') && !canTransition('collecting_evidence', 'verified'),
    'no path from evidence collection directly to verified',
  );
  const c1 = mk('automated_checks_passed');
  ok(
    applyTransition(c1, 'verified', { method: 'document_submitted', actorKind: 'org_admin' }) ===
      'METHOD_NOT_AUTHORITATIVE',
    'document_submitted can NEVER produce a verified claim',
  );
  ok(c1.status === 'automated_checks_passed', 'failed transition mutates nothing');
  const c2 = mk('automated_checks_passed', { claimType: 'ORGANISATION_IDENTITY' });
  ok(
    applyTransition(c2, 'verified', { method: 'official_domain_email', actorKind: 'system' }) ===
      'DOMAIN_CONTROL_INSUFFICIENT',
    'domain-email control alone cannot verify ORGANISATION_IDENTITY (security case 17)',
  );
  const c3 = mk('automated_checks_passed', { claimType: 'ORGANISATION_DOMAIN' });
  ok(
    applyTransition(c3, 'verified', { method: 'official_domain_email', actorKind: 'system' }) === null &&
      c3.status === 'verified',
    'official_domain_email verifies exactly the DOMAIN claim',
  );
  const c4 = mk('verified', { verificationMethod: 'organisation_admin_confirmation', verifiedAt: 1 });
  ok(applyTransition(c4, 'revoked', {}) === 'REASON_REQUIRED', 'revocation without a reason is refused');
  ok(
    applyTransition(c4, 'revoked', { reason: 'left club', actorKind: 'org_admin', actorId: 'a1' }) === null &&
      c4.current === false,
    'revocation records reason and ends currency',
  );
  ok(
    applyTransition(c4, 'verified', { method: 'organisation_admin_confirmation', actorKind: 'trust_safety' }) === null,
    'reinstatement from revoked is possible (policy-gated at the route)',
  );
  ok(
    applyTransition(mk('rejected'), 'verified', { method: 'scoutbox_manual_review' }) === 'ILLEGAL_TRANSITION',
    'rejected is terminal — resubmission is a NEW claim',
  );
  const c5 = mk('verified', { verificationMethod: 'organisation_admin_confirmation' });
  ok(
    applyTransition(c5, 'verified', {}) === 'ALREADY_IN_STATE',
    'idempotent: same-state transition is rejected predictably',
  );
}

section('unit fixtures — effective engine (read-time truth)');
{
  const base = {
    status: 'verified',
    current: true,
    validFrom: 1,
    validUntil: null,
    organisationId: 'o1',
    verificationMethod: 'organisation_admin_confirmation',
  };
  const okOrg = { id: 'o1', suspended: false, verificationRevokedAt: null };
  ok(effectiveStatus({ ...base }, { org: okOrg }).displayable === true, 'verified + eligible org displays');
  ok(
    effectiveStatus({ ...base, validUntil: Date.now() - 1000 }, { org: okOrg }).status === 'expired',
    'validUntil in the past reads as expired regardless of stored status',
  );
  ok(
    effectiveStatus({ ...base }, { org: { ...okOrg, suspended: true } }).displayable === false,
    'suspended organisation suppresses the badge at read time',
  );
  ok(
    effectiveStatus({ ...base }, { org: { ...okOrg, verificationRevokedAt: 5 } }).displayable === false,
    'revoked organisation suppresses the badge',
  );
  const hist = effectiveStatus({ ...base, current: false, validUntil: Date.now() + 10 }, { org: okOrg });
  ok(
    hist.displayable === true && hist.historical === true && hist.current === false,
    'closed period stays displayable as HISTORY (security case 15: never as current)',
  );
  ok(
    effectiveStatus({ ...base, current: false, validUntil: 99 }, { org: { ...okOrg, verificationRevokedAt: 5 } })
      .displayable === false,
    'a fraud-revoked organisation stops lending even historical badges',
  );
}

section('unit fixtures — deterministic decision engine + risk flags');
{
  const d1 = decideReview({ claimType: 'ORGANISATION_IDENTITY', isFirstOrgAdmin: true });
  ok(
    d1.decision === 'REQUIRES_HUMAN_REVIEW' && d1.reasons.includes('ROOT_ORGANISATION_BOOTSTRAP'),
    'first org admin ALWAYS requires human review',
  );
  ok(
    decideReview({ claimType: 'CLUB_ROLE', orgHasActiveAuthority: true }).decision === 'CAN_AUTO_COMPLETE',
    'affiliation with an active org authority routes to the ORG, not to T&S',
  );
  const d2 = decideReview({ claimType: 'CLUB_ROLE', orgHasActiveAuthority: false });
  ok(
    d2.decision === 'REQUIRES_HUMAN_REVIEW' && d2.reasons.includes('NO_AUTHORITATIVE_SOURCE'),
    'no authoritative source → human review with the exact reason code',
  );
  ok(
    decideReview({ claimType: 'LICENCE', documentOnly: true, orgHasActiveAuthority: true }).reasons.includes(
      'DOCUMENT_AUTHENTICITY_UNCONFIRMED',
    ),
    'document-only licence never auto-completes',
  );
  ok(
    decideReview({ claimType: 'LICENCE', documentOnly: true, registryResult: 'match', orgHasActiveAuthority: true })
      .decision === 'CAN_AUTO_COMPLETE',
    'a registry MATCH is the authoritative exception',
  );
  ok(
    decideReview({ claimType: 'CLUB_ROLE', orgHasActiveAuthority: true, registryResult: 'ambiguous' }).reasons.includes(
      'REGISTRY_AMBIGUOUS_MATCH',
    ),
    'ambiguous registry result forces a human',
  );
  const rf = riskFlags({ email: 'x@mailinator.com', orgDomains: ['club.com'], actorIsSubject: true });
  ok(
    rf.includes('DISPOSABLE_EMAIL') && rf.includes('ORG_DOMAIN_MISMATCH') && rf.includes('SELF_VERIFICATION_ATTEMPT'),
    'risk flags are deterministic signals',
  );
  ok(
    riskFlags({ email: 'a@gmail.com' }).includes('FREE_EMAIL_PROVIDER') &&
      !riskFlags({ email: 'a@chelseafc.com' }).length,
    'free-mail flagged; clean corporate address has no flags',
  );
}

section('unit fixtures — email/domain/evidence/token primitives');
{
  ok(emailProblem('not-an-email') === 'EMAIL_SYNTAX' && emailProblem('a@b.co') === null, 'email syntax validation');
  ok(
    normalizeDomain('https://www.ChelseaFC.com/tickets') === 'chelseafc.com',
    'domain normalisation strips scheme/www/path/case',
  );
  ok(
    domainCovered('mail.chelseafc.com', 'chelseafc.com') && !domainCovered('chelseafc.com.evil.io', 'chelseafc.com'),
    'subdomain coverage cannot be spoofed by suffix tricks',
  );
  ok(
    isFreeMail('gmail.com') && isDisposable('mailinator.com') && !isFreeMail(domainOfEmail('m@chelseafc.com')),
    'free/disposable classification',
  );
  ok(
    evidenceFileProblem({ mime: 'application/pdf', bytes: 1000, filename: 'licence.pdf' }) === null,
    'pdf within limits accepted',
  );
  ok(
    evidenceFileProblem({ mime: 'image/svg+xml', bytes: 100, filename: 'a.svg' }) === 'FILE_TYPE_NOT_ALLOWED',
    'svg (scriptable) refused',
  );
  ok(
    evidenceFileProblem({ mime: 'application/pdf', bytes: 100, filename: '../../etc/passwd' }) === 'FILENAME_INVALID',
    'path traversal in filename refused',
  );
  ok(
    evidenceFileProblem({ mime: 'application/pdf', bytes: 9 * 1024 * 1024, filename: 'big.pdf' }) === 'FILE_TOO_LARGE',
    'oversize refused',
  );
  ok(
    !evidenceCompleteness('PERSON_IDENTITY', []).complete &&
      evidenceCompleteness('PERSON_IDENTITY', ['document']).complete,
    'identity claims need a document before submission',
  );

  const fdb = { verTokens: [] };
  const ts = arrayTokenStore(fdb.verTokens); // the token functions take a store (the server's is the repository)
  const nid = (() => {
    let n = 0;
    return (p) => `${p}-${++n}`;
  })();
  const secret = mintToken(ts, nid, { purpose: 'work_email', email: 'a@club.com', subjectId: 'u1' });
  ok(
    !fdb.verTokens[0].hash.includes(secret) && fdb.verTokens[0].hash.length === 64,
    'tokens are stored hashed, never in plain text',
  );
  ok(
    consumeToken(ts, { purpose: 'player_invite', secret }).error === 'TOKEN_WRONG_PURPOSE',
    'purpose binding enforced',
  );
  ok(
    consumeToken(ts, { purpose: 'work_email', secret, subjectId: 'u2' }).error === 'TOKEN_WRONG_ACCOUNT',
    'account binding enforced (Alice token refused for Bob)',
  );
  ok(
    consumeToken(ts, { purpose: 'work_email', secret, email: 'other@club.com' }).error === 'TOKEN_WRONG_ADDRESS',
    'address binding enforced',
  );
  ok(
    consumeToken(ts, { purpose: 'work_email', secret, subjectId: 'u1', email: 'a@club.com' }).token != null,
    'correct bindings consume the token',
  );
  ok(
    consumeToken(ts, { purpose: 'work_email', secret }).error === 'TOKEN_ALREADY_USED',
    'single use: replay refused (security case 5/11)',
  );
  const secret2 = mintToken(ts, nid, { purpose: 'work_email', ttlMs: -1 });
  ok(consumeToken(ts, { purpose: 'work_email', secret: secret2 }).error === 'TOKEN_EXPIRED', 'expired token refused');
  ok(consumeToken(ts, { purpose: 'work_email', secret: 'guess' }).error === 'TOKEN_UNKNOWN', 'unknown token refused');
}

section('unit fixtures — safe public projector');
{
  const org = { id: 'o1', name: 'Chelsea FC', suspended: false, verificationRevokedAt: null };
  const claims = [
    {
      subjectType: 'user',
      subjectId: 'u1',
      claimType: 'PERSON_IDENTITY',
      status: 'verified',
      current: true,
      verificationMethod: 'scoutbox_manual_review',
      organisationId: null,
      metadata: {},
    },
    {
      subjectType: 'user',
      subjectId: 'u1',
      claimType: 'CLUB_ROLE',
      role: 'Academy Scout',
      status: 'verified',
      current: true,
      organisationId: 'o1',
      verificationMethod: 'organisation_admin_confirmation',
      verifiedAt: 5,
      validFrom: 1,
      metadata: { workEmail: 'secret@chelseafc.com' },
      riskFlags: ['X'],
      evidenceIds: ['e1'],
    },
    {
      subjectType: 'user',
      subjectId: 'u1',
      claimType: 'LICENCE',
      status: 'pending',
      organisationId: null,
      verificationMethod: 'document_submitted',
      metadata: { licenceType: 'UEFA A' },
      current: true,
    },
  ];
  const prof = toPublicVerificationProfile({
    subjectType: 'user',
    subjectId: 'u1',
    claims,
    orgsById: new Map([['o1', org]]),
  });
  ok(
    prof.identityVerified === true && prof.badges.length === 1,
    'projector: identity flag + ONLY displayable claims (pending licence excluded — security case 16)',
  );
  ok(
    prof.badges[0].label === 'Role verified: Academy Scout' &&
      prof.badges[0].provenance.includes('authorised Chelsea FC administrator'),
    'badge defines the verified fact and its provenance in plain English',
  );
  const s = JSON.stringify(prof);
  ok(
    !s.includes('secret@') && !s.includes('riskFlags') && !s.includes('evidenceIds') && !s.includes('workEmail'),
    'projector leaks no emails, no evidence, no risk flags',
  );
  ok(
    orgVerificationStatus({ verified: true, suspended: true }, false) === 'suspended',
    'org lifecycle: suspension outranks verified',
  );
  ok(
    verLevelFor(
      [
        { orgId: 'o', userId: 'u', level: 'verification_reviewer', status: 'active' },
        { orgId: 'o', userId: 'u', level: 'verification_root_admin', status: 'revoked' },
      ],
      'o',
      'u',
    ) === 'verification_reviewer',
    'revoked authority rows do not count',
  );
}

done();
