// Organisation verification: personal claims, work-email proof, the club Verification console, official domains,
// the verification-admin hierarchy (with dual control), squad invitations, conflict declarations and coach references.
//
// A person can never verify themselves. Employment and role facts are confirmed by an authorised administrator of a
// verified organisation; domain control is evidence of mailbox control, not of employment. Where no authority
// exists, the case routes to Trust & Safety as a prepared human-review case.
import { strictContext } from '../../platform/deps.mjs';
import { verLevelRank } from './shared.mjs';
import { registerPersonalRoutes } from './personalRoutes.mjs';
import { registerConsoleRoutes } from './consoleRoutes.mjs';
import { registerOrgAdminRoutes } from './orgAdminRoutes.mjs';
import { registerInviteRoutes } from './inviteRoutes.mjs';
import { registerReferenceRoutes } from './referenceRoutes.mjs';
import { registerApplicationRoutes } from './applicationRoutes.mjs';

export function registerOrganisationVerification(ctx) {
  const {
    byId,
    app,
    orgRouter,
    playerRouter,
    guardianRouter,
    nextId,
    notify,
    mailer,
    verification,
    reads,
    unit,
    verEvent,
    createClaim,
    transition,
    addEvidence,
    storeEvidenceFile,
    requireVer,
    vmetric,
    publicProfileForUser,
    publicProfileForOrg,
    mintToken,
    effectiveStatus,
    orgCanAttest,
    verLevelFor,
    hasVerLevel,
    findPlayer,
    isBlocked,
    randomHex,
    orgVerificationStatus,
    peekToken,
    useToken,
    ledgerAppend,
    orgs,
    claimProvenanceLabel,
  } = ctx;

  const openStates = [
    'unverified',
    'collecting_evidence',
    'pending',
    'automated_checks_passed',
    'requires_human_review',
  ];
  const userClaims = (userId) => reads.claims.forSubject('user', userId);
  const orgOf = (id) => byId.org(id) ?? null;
  const verifiedDomainsOf = (orgId) =>
    reads.domains
      .forOrg(orgId)
      .filter((d) => d.status === 'verified')
      .map((d) => d.domain);
  const reviewersOf = (orgId, atLeast = 'verification_reviewer') =>
    reads.admins
      .activeForOrg(orgId)
      .filter((a) => verLevelRank(a.level) >= verLevelRank(atLeast))
      .map((a) => byId.user(a.userId, (u) => !u.removedAt))
      .filter(Boolean);
  const notifyReviewers = (orgId, text, refId) => {
    for (const u of reviewersOf(orgId)) notify({ kind: 'org_user', id: u.id }, 'verification', text, refId);
  };
  const emailFailsFor = (userId) => reads.tokens.failedAttempts(userId, 'work_email');
  const onlyOrg = (req, r) => (r && r.orgId === req.org.id ? r : null);

  // Never someone else's evidence, never reviewer notes.
  const subjectClaimView = (claim) => {
    const org = claim.organisationId ? orgOf(claim.organisationId) : null;
    const eff = effectiveStatus(claim, { org });
    return {
      id: claim.id,
      claimType: claim.claimType,
      status: claim.status,
      effective: { status: eff.status, current: eff.current, historical: eff.historical },
      organisation: org ? { id: org.id, name: org.name } : null,
      role: claim.role,
      validFrom: claim.validFrom,
      validUntil: claim.validUntil,
      current: claim.current,
      verificationMethod: claim.verificationMethod,
      verifiedAt: claim.verifiedAt,
      provenance: claim.status === 'verified' ? claimProvenanceLabel(claim, org?.name) : null,
      reviewReasons: claim.reviewReasons,
      createdAt: claim.createdAt,
      updatedAt: claim.updatedAt,
      revocationReason: claim.revocationReason,
      disputedAt: claim.disputedAt,
      evidence: reads.evidence.byIds(claim.evidenceIds).map((e) => ({
        id: e.id,
        type: e.type,
        receivedAt: e.receivedAt,
        filename: e.filename,
        checks: e.checks,
        note: e.meta?.note ?? null,
      })),
      humanReviewNote: claim.status === 'requires_human_review' ? humanReviewExplanation(claim) : null,
    };
  };
  function humanReviewExplanation(claim) {
    // Plain language, without leaking internal security rules.
    const bits = [];
    if (claim.reviewReasons.includes('ROOT_ORGANISATION_BOOTSTRAP'))
      bits.push('an authorised organisation administrator has not yet been established for this organisation');
    if (claim.reviewReasons.includes('NO_AUTHORITATIVE_SOURCE'))
      bits.push('no authorised administrator or authoritative registry can confirm this automatically');
    if (claim.reviewReasons.includes('DOCUMENT_AUTHENTICITY_UNCONFIRMED'))
      bits.push('an uploaded document is evidence, not proof — a reviewer checks it against authoritative sources');
    if (claim.reviewReasons.includes('DISPUTED_CLAIM')) bits.push('the claim is under dispute');
    return `ScoutBox needs to review this request${bits.length ? ` because ${bits.join('; ')}` : ''}.`;
  }

  // Each part adds what it offers the later ones, so the parts are created in this order and register their routes in
  // it. Reading a name a part has not been given yet throws outside production.
  const parts = {
    byId,
    app,
    orgRouter,
    playerRouter,
    guardianRouter,
    nextId,
    notify,
    mailer,
    verification,
    reads,
    unit,
    verEvent,
    createClaim,
    transition,
    addEvidence,
    storeEvidenceFile,
    requireVer,
    vmetric,
    publicProfileForUser,
    publicProfileForOrg,
    mintToken,
    effectiveStatus,
    orgCanAttest,
    verLevelFor,
    hasVerLevel,
    findPlayer,
    isBlocked,
    randomHex,
    orgVerificationStatus,
    peekToken,
    useToken,
    ledgerAppend,
    orgs,
    openStates,
    userClaims,
    orgOf,
    verifiedDomainsOf,
    reviewersOf,
    notifyReviewers,
    emailFailsFor,
    onlyOrg,
    subjectClaimView,
  };
  const strict = strictContext('registerOrganisationVerification', parts);
  Object.assign(parts, registerPersonalRoutes(strict));
  registerConsoleRoutes(strict);
  registerOrgAdminRoutes(strict);
  registerInviteRoutes(strict);
  registerReferenceRoutes(strict);
  registerApplicationRoutes(strict);
}
