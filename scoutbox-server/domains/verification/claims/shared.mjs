// Verification core. Verification is a set of independent claims, each recording what was established, how, by
// whom and on what evidence; there is no account-level `verified: true`. An uploaded document is evidence, never the
// method of a verified claim, and nobody can be the authoritative confirmer of their own claim.
import crypto from 'node:crypto';
import { isExpiredAt, readInstant } from '../../../temporal.mjs';

// ------------------------------------------------------------- vocabularies
import {
  CLAIM_TYPES,
  CLAIM_STATES,
  CLAIM_TRANSITIONS,
  METHODS,
  REVIEW_REASONS,
  EVIDENCE_TYPES,
  EVIDENCE_VISIBILITY,
  VER_LEVELS,
  VERIFICATION_LIMITS,
} from '../../../repositories/verification.mjs';
export { CLAIM_TYPES, CLAIM_STATES, METHODS, REVIEW_REASONS, EVIDENCE_TYPES, EVIDENCE_VISIBILITY, VER_LEVELS };

// Methods that may accompany a transition into `verified`. document_submitted is evidence collection, not one.
export const AUTHORITATIVE_METHODS = new Set([
  'official_domain_email', // only proves domain control (ORGANISATION_DOMAIN)
  'organisation_admin_confirmation',
  'authoritative_registry',
  'federation_confirmation',
  'existing_verified_org_admin',
  'scoutbox_manual_review',
  'migration', // carries forward a previously established fact, labelled as such
]);

// ---------------------------------------------------------- state machine
// The repository also guards every move by this map in SQL.
export const VALID_TRANSITIONS = CLAIM_TRANSITIONS;

export function canTransition(from, to) {
  return (VALID_TRANSITIONS[from] ?? []).includes(to);
}

/** `{ error }`, or `{ changes }`: the fields the move sets besides its status. Never mutates. */
export function transitionChanges(claim, to, { actorKind, actorId, method, reason, now = Date.now() } = {}) {
  if (!CLAIM_STATES.includes(to)) return { error: 'UNKNOWN_STATE' };
  if (claim.status === to) return { error: 'ALREADY_IN_STATE' };
  if (!canTransition(claim.status, to)) return { error: 'ILLEGAL_TRANSITION' };
  if (to === 'verified') {
    const m = method ?? claim.verificationMethod;
    if (!m || !AUTHORITATIVE_METHODS.has(m)) return { error: 'METHOD_NOT_AUTHORITATIVE' };
    if (m === 'official_domain_email' && !['ORGANISATION_DOMAIN'].includes(claim.claimType)) {
      // Domain control alone does not prove employment or identity.
      return { error: 'DOMAIN_CONTROL_INSUFFICIENT' };
    }
  }
  if (['revoked', 'suspended', 'rejected'].includes(to) && !reason) return { error: 'REASON_REQUIRED' };
  const why = reason ? String(reason).slice(0, VERIFICATION_LIMITS.reason) : reason;
  const changes = { updatedAt: now };
  if (to === 'verified') {
    Object.assign(changes, {
      verificationMethod: method ?? claim.verificationMethod,
      verifiedAt: claim.verifiedAt ?? now,
      verifiedBy: { kind: actorKind ?? 'system', id: actorId ?? null },
      suspendedAt: null,
      disputedAt: null,
    });
  }
  if (to === 'revoked')
    Object.assign(changes, {
      revokedAt: now,
      revokedBy: { kind: actorKind, id: actorId ?? null },
      revocationReason: why,
      current: false,
    });
  if (to === 'suspended') Object.assign(changes, { suspendedAt: now, suspendReason: why });
  if (to === 'disputed') changes.disputedAt = now;
  if (to === 'expired') changes.expiredAt = now;
  if (to === 'superseded') changes.current = false;
  return { changes };
}
/** Null on success or an error code; never mutates on failure. */
export function applyTransition(claim, to, opts = {}) {
  const t = transitionChanges(claim, to, opts);
  if (t.error) return t.error;
  Object.assign(claim, t.changes, { status: to });
  return null;
}

// --------------------------------------------------- effective-claim engine
// A claim displays as verified only if every condition holds at read time.
export function effectiveStatus(claim, { org = null, subjectRemoved = false, now = Date.now() } = {}) {
  const reasons = [];
  let status = claim.status;
  // Expiry applies to current claims; a closed period remains a verified past fact. `validUntil` is exclusive, null
  // means no expiry, and an unreadable value reads expired rather than as "no expiry".
  if (status === 'verified' && claim.current !== false && isExpiredAt(claim.validUntil, now)) {
    status = 'expired';
    reasons.push('VALID_UNTIL_PASSED');
  }
  if (subjectRemoved && claim.current) reasons.push('SUBJECT_ACCOUNT_INACTIVE');
  const orgScoped = !!claim.organisationId;
  if (orgScoped) {
    if (!org) {
      reasons.push('ORGANISATION_MISSING');
    } else {
      if (org.suspended) reasons.push('ORGANISATION_SUSPENDED');
      if (org.verificationRevokedAt) reasons.push('ORGANISATION_REVOKED');
    }
  }
  // A closed verified period stays displayable as history after the person left.
  const verifiedNow = status === 'verified' && reasons.length === 0;
  const verifiedHistorical =
    status === 'verified' && claim.current === false && !!claim.validUntil && !reasons.includes('ORGANISATION_REVOKED'); // fraud-revoked orgs stop lending history
  return {
    status,
    displayable: verifiedNow || verifiedHistorical,
    current: verifiedNow && claim.current !== false,
    historical: verifiedHistorical && !(verifiedNow && claim.current !== false),
    reasons,
  };
}

// ------------------------------------------------- email / domain helpers
export const FREE_MAIL_DOMAINS =
  /^(gmail|googlemail|hotmail|outlook|yahoo|icloud|aol|proton|protonmail|gmx|live|msn|mail|yandex|zoho)\./i;
export const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'tempmail.dev',
  'yopmail.com',
  'sharklasers.com',
  'trashmail.com',
  'dispostable.com',
]);
export function emailProblem(email) {
  const e = String(email ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e)) return 'EMAIL_SYNTAX';
  if (e.length > 254) return 'EMAIL_TOO_LONG';
  return null;
}
export function normalizeDomain(domain) {
  return String(domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split(':')[0];
}
export const domainOfEmail = (email) => normalizeDomain(String(email ?? '').split('@')[1] ?? '');
export const isFreeMail = (domain) =>
  FREE_MAIL_DOMAINS.test(`${normalizeDomain(domain)}.`) || FREE_MAIL_DOMAINS.test(normalizeDomain(domain));
export const isDisposable = (domain) => DISPOSABLE_DOMAINS.has(normalizeDomain(domain));
/** True when `candidate` is the org domain or a subdomain of it. */
export function domainCovered(candidate, orgDomain) {
  const c = normalizeDomain(candidate),
    o = normalizeDomain(orgDomain);
  return !!c && !!o && (c === o || c.endsWith(`.${o}`));
}

// ------------------------------------------------------------ risk signals
// Signals, not conclusions: nothing downstream may describe a flag as fraud, and no flag alone rejects anything.
export function riskFlags(input) {
  const {
    email,
    orgDomains = [],
    applicantHadRecentRevocation = false,
    duplicateEvidenceHash = false,
    competingOrgClaims = 0,
    orgSuspended = false,
    conflictingActiveRoles = 0,
    requestsLastDay = 0,
    actorIsSubject = false,
    emailChallengeFails = 0,
    credentialReusedByOthers = false,
  } = input;
  const flags = [];
  const dom = domainOfEmail(email ?? '');
  if (email && isDisposable(dom)) flags.push('DISPOSABLE_EMAIL');
  if (email && isFreeMail(dom)) flags.push('FREE_EMAIL_PROVIDER');
  if (email && orgDomains.length && !orgDomains.some((d) => domainCovered(dom, d))) flags.push('ORG_DOMAIN_MISMATCH');
  if (emailChallengeFails >= 3) flags.push('REPEATED_EMAIL_CHALLENGE_FAILURES');
  if (competingOrgClaims > 0) flags.push('COMPETING_ORGANISATION_CLAIMS');
  if (credentialReusedByOthers) flags.push('CREDENTIAL_REUSED_ACROSS_USERS');
  if (duplicateEvidenceHash) flags.push('DUPLICATE_EVIDENCE_HASH');
  if (applicantHadRecentRevocation) flags.push('RECENT_REVOCATION_REAPPLY');
  if (orgSuspended) flags.push('ORGANISATION_SUSPENDED');
  if (conflictingActiveRoles > 0) flags.push('CONFLICTING_ACTIVE_ROLES');
  if (requestsLastDay >= 25) flags.push('UNUSUAL_MASS_ACTIVITY');
  if (actorIsSubject) flags.push('SELF_VERIFICATION_ATTEMPT');
  return flags;
}

// ------------------------------------------------- human-review decision
// "Auto" means no Trust & Safety human is needed: an authorised organisation administrator confirming their own staff
// is the authoritative source, not a fallback.
export function decideReview(input) {
  const {
    claimType,
    orgHasActiveAuthority = false,
    isFirstOrgAdmin = false,
    duplicateOrg = false,
    conflictingEvidence = false,
    identityMismatch = false,
    domainAmbiguous = false,
    registryResult = null,
    disputed = false,
    highRiskAdminChange = false,
    manualException = false,
    riskFlagCount = 0,
    documentOnly = false,
  } = input;
  const reasons = [];
  if (isFirstOrgAdmin) reasons.push('ROOT_ORGANISATION_BOOTSTRAP');
  if (duplicateOrg) reasons.push('DUPLICATE_ORGANISATION');
  if (conflictingEvidence) reasons.push('CONFLICTING_EVIDENCE');
  if (identityMismatch) reasons.push('IDENTITY_MISMATCH');
  if (domainAmbiguous) reasons.push('DOMAIN_OWNERSHIP_AMBIGUOUS');
  if (registryResult === 'ambiguous') reasons.push('REGISTRY_AMBIGUOUS_MATCH');
  if (disputed) reasons.push('DISPUTED_CLAIM');
  if (highRiskAdminChange) reasons.push('HIGH_RISK_ADMIN_CHANGE');
  if (manualException) reasons.push('MANUAL_EXCEPTION_REQUESTED');
  if (riskFlagCount >= 3) reasons.push('SUSPECTED_FRAUD_SIGNALS');
  const affiliationLike = [
    'CLUB_AFFILIATION',
    'CLUB_ROLE',
    'AGENCY_AFFILIATION',
    'AGENCY_ROLE',
    'GRASSROOTS_AFFILIATION',
    'FEDERATION_AFFILIATION',
  ].includes(claimType);
  if (affiliationLike && !orgHasActiveAuthority) reasons.push('NO_AUTHORITATIVE_SOURCE');
  if (['PERSON_IDENTITY', 'LICENCE'].includes(claimType) && documentOnly && registryResult !== 'match') {
    reasons.push('DOCUMENT_AUTHENTICITY_UNCONFIRMED');
  }
  return { decision: reasons.length ? 'REQUIRES_HUMAN_REVIEW' : 'CAN_AUTO_COMPLETE', reasons };
}

// ------------------------------------------------------ evidence handling
export const EVIDENCE_MIME_ALLOW = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
export const EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;
/** The claimed MIME and extension are attacker-controlled; the leading bytes are not. Format identification only,
 *  not malware scanning. */
export function sniffFileSignature(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
    return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP')
    return 'image/webp';
  return null;
}
export function evidenceFileProblem({ mime, bytes, filename, buffer = null }) {
  if (!EVIDENCE_MIME_ALLOW.has(String(mime))) return 'FILE_TYPE_NOT_ALLOWED';
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > EVIDENCE_MAX_BYTES) return 'FILE_TOO_LARGE';
  const name = String(filename ?? '');
  if (/[\\/]|\.\./.test(name)) return 'FILENAME_INVALID'; // no traversal
  if (/\.(exe|js|sh|bat|cmd|com|scr|msi|dll|svg|html?)$/i.test(name)) return 'FILE_TYPE_NOT_ALLOWED';
  if (buffer !== null) {
    // The bytes must be the format they claim to be.
    const detected = sniffFileSignature(buffer);
    if (!detected) return 'FILE_CONTENT_UNRECOGNISED';
    if (detected !== String(mime)) return 'FILE_SIGNATURE_MISMATCH';
  }
  return null;
}
export function evidenceCompleteness(claimType, evidenceTypes) {
  const have = new Set(evidenceTypes);
  const need =
    {
      PERSON_IDENTITY: ['document'],
      ORGANISATION_IDENTITY: ['document'],
      LICENCE: ['document'],
      CLUB_AFFILIATION: ['official_email'],
      CLUB_ROLE: ['official_email'],
      GRASSROOTS_AFFILIATION: [],
      FEDERATION_AFFILIATION: [],
      AGENCY_AFFILIATION: ['official_email'],
      AGENCY_ROLE: ['official_email'],
      ORGANISATION_DOMAIN: ['official_email'],
      ORGANISATION_ADMIN: [],
    }[claimType] ?? [];
  const missing = need.filter((t) => !have.has(t));
  return { complete: missing.length === 0, missing };
}

// -------------------------------------------------------------- tokens
// Hashed at rest, expiring, single-use, bound to a purpose and an address or subject. The plain secret exists only in
// the e-mail that carries it.
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export function mintToken(
  store,
  nextId,
  { purpose, email = null, subjectKind = null, subjectId = null, orgId = null, refId = null, ttlMs = 30 * 60_000 },
) {
  const secret = crypto.randomBytes(24).toString('base64url');
  const at = Date.now();
  store.create({
    id: nextId('vtk'),
    hash: sha256(secret),
    purpose,
    email: email ? String(email).trim().toLowerCase() : null,
    subjectKind,
    subjectId,
    orgId,
    refId,
    createdAt: at,
    expiresAt: at + ttlMs,
    usedAt: null,
    attemptsFailed: 0,
  });
  return secret;
}
/** Callers with extra binding checks peek first and mark the token used only after them, so a failed binding attempt
 *  does not burn the rightful recipient's single-use secret. */
export function peekToken(store, { purpose, secret, email = null, subjectId = null }) {
  const t = store.byHash(sha256(secret ?? ''));
  if (!t) return { error: 'TOKEN_UNKNOWN' };
  if (t.purpose !== purpose) return { error: 'TOKEN_WRONG_PURPOSE' };
  if (t.usedAt) return { error: 'TOKEN_ALREADY_USED' };
  if (t.expiresAt < Date.now()) return { error: 'TOKEN_EXPIRED' };
  if (t.email && email && t.email !== String(email).toLowerCase()) return { error: 'TOKEN_WRONG_ADDRESS' };
  if (t.subjectId && subjectId && t.subjectId !== subjectId) return { error: 'TOKEN_WRONG_ACCOUNT' };
  return { token: t };
}
export const useToken = (store, token) => store.use(token.id, { at: Date.now() });
/** Marks used on success only. */
export function consumeToken(store, { purpose, secret, email = null, subjectId = null }) {
  const out = peekToken(store, { purpose, secret, email, subjectId });
  if (out.error) return out;
  return { token: useToken(store, out.token) };
}
/** For fixtures and unit checks. */
export function arrayTokenStore(list = []) {
  return {
    rows: list,
    create: (row) => {
      list.push({ ...row });
      return row;
    },
    byHash: (hash) => list.find((t) => t.hash === hash) ?? null,
    use: (id, { at }) => {
      const t = list.find((x) => x.id === id);
      t.usedAt = at;
      return t;
    },
  };
}

// ------------------------------------------- verification admin hierarchy
export const verLevelRank = (level) => VER_LEVELS.indexOf(level);
/** `source` is a list of administrator rows, or the verification reads. */
const adminRows = (source, orgId, userId) => (Array.isArray(source) ? source : source.admins.activeFor(orgId, userId));
export function verLevelFor(source, orgId, userId) {
  const rows = adminRows(source, orgId, userId).filter(
    (a) => a.orgId === orgId && a.userId === userId && a.status === 'active',
  );
  if (!rows.length) return null;
  return rows.reduce((best, a) => (verLevelRank(a.level) > verLevelRank(best) ? a.level : best), rows[0].level);
}
export function hasVerLevel(source, orgId, userId, atLeast) {
  const lvl = verLevelFor(source, orgId, userId);
  return lvl !== null && verLevelRank(lvl) >= verLevelRank(atLeast);
}

// ------------------------------------------------ organisation lifecycle
/** `pending`: whether a root application is still open, as a boolean or the verification reads. */
export function orgVerificationStatus(org, pending = false) {
  if (!org) return 'unverified';
  if (org.verificationRevokedAt) return 'revoked';
  if (org.suspended) return 'suspended';
  if (org.verified) return 'verified';
  const pendingRoot = typeof pending === 'boolean' ? pending : !!pending?.rootRequests?.openForOrg(org.id);
  return pendingRoot ? 'pending' : 'unverified';
}
/** Can this org currently mint new effective verified affiliation claims? */
export function orgCanAttest(org, pending = false) {
  return orgVerificationStatus(org, pending) === 'verified';
}

// --------------------------------------------------------- public projection
// Everything any client shows publicly about verification flows through here.
// Assurance says who stands behind a verified claim:
//   authoritative            → an external authoritative source confirmed it
//   organisation_attested    → an authorised org administrator confirmed it
//   scoutbox_document_review → ScoutBox reviewed documents; not confirmed with any issuing authority
export function assuranceForClaim(claim) {
  switch (claim.verificationMethod) {
    case 'authoritative_registry':
    case 'federation_confirmation':
      return 'authoritative';
    case 'official_domain_email':
      return 'authoritative'; // authoritative for what it proves: domain control only
    case 'organisation_admin_confirmation':
    case 'existing_verified_org_admin':
      return 'organisation_attested';
    case 'scoutbox_manual_review':
    case 'migration': // carried-forward facts trace back to a ScoutBox review
      return 'scoutbox_document_review';
    default:
      return null;
  }
}
export function claimProvenanceLabel(claim, orgName) {
  // A manual review of a licence document must not read like an issuing-authority confirmation.
  if (claim.claimType === 'LICENCE' && claim.verificationMethod === 'scoutbox_manual_review') {
    return 'Document reviewed by ScoutBox Trust & Safety — not independently confirmed with the issuing authority.';
  }
  switch (claim.verificationMethod) {
    case 'organisation_admin_confirmation':
      return `Confirmed by an authorised ${orgName ?? 'organisation'} administrator`;
    case 'existing_verified_org_admin':
      return `Confirmed by an existing verified ${orgName ?? 'organisation'} administrator`;
    case 'authoritative_registry':
      return 'Confirmed against an authoritative registry';
    case 'federation_confirmation':
      return 'Confirmed by the governing federation';
    case 'official_domain_email':
      return 'Confirmed control of the official organisation domain';
    case 'scoutbox_manual_review':
      return 'Reviewed and confirmed by ScoutBox Trust & Safety';
    case 'migration':
      return 'Carried forward from a previously established ScoutBox verification';
    default:
      return 'Not independently verified';
  }
}
const CLAIM_BADGE_KIND = {
  PERSON_IDENTITY: 'identity',
  ORGANISATION_IDENTITY: 'organisation',
  ORGANISATION_DOMAIN: 'domain',
  ORGANISATION_ADMIN: 'admin',
  CLUB_AFFILIATION: 'affiliation',
  CLUB_ROLE: 'role',
  LICENCE: 'licence',
  AGENCY_AFFILIATION: 'affiliation',
  AGENCY_ROLE: 'role',
  GRASSROOTS_AFFILIATION: 'affiliation',
  FEDERATION_AFFILIATION: 'affiliation',
};
export function toPublicVerificationProfile({
  subjectType,
  subjectId,
  claims,
  orgsById = new Map(),
  subjectRemoved = false,
  now = Date.now(),
}) {
  const badges = [];
  let identity = null;
  for (const claim of claims) {
    const org = claim.organisationId ? (orgsById.get(claim.organisationId) ?? null) : null;
    const eff = effectiveStatus(claim, { org, subjectRemoved, now });
    if (!eff.displayable) continue;
    const y = (ms) => (readInstant(ms) !== null && ms ? new Date(ms).getUTCFullYear() : null); // UTC, not the server's zone
    if (claim.claimType === 'PERSON_IDENTITY') {
      // A manual document review must be distinguishable from an authoritative identity provider.
      const assurance = assuranceForClaim(claim);
      identity = {
        confirmed: true,
        assurance,
        label:
          assurance === 'authoritative'
            ? 'Identity confirmed by an authoritative provider'
            : 'Identity confirmed by ScoutBox review',
        verifiedAt: claim.verifiedAt ?? null,
        provenance:
          assurance === 'authoritative'
            ? claimProvenanceLabel(claim, org?.name)
            : 'Reviewed and confirmed by ScoutBox Trust & Safety — a document review, not an authoritative identity check',
      };
      continue;
    }
    badges.push({
      kind: CLAIM_BADGE_KIND[claim.claimType] ?? 'claim',
      claimType: claim.claimType,
      label: badgeLabel(claim, org, eff),
      organisation: org ? { id: org.id, name: org.name } : null,
      role: claim.role ?? null,
      current: eff.current,
      historical: eff.historical,
      assurance: assuranceForClaim(claim),
      period: claim.validFrom ? { from: y(claim.validFrom), to: claim.validUntil ? y(claim.validUntil) : null } : null,
      verifiedAt: claim.verifiedAt ?? null,
      provenance: claimProvenanceLabel(claim, org?.name),
    });
  }
  // identityVerified is for existing clients; `identity` is the full representation.
  return { subjectType, subjectId, identityVerified: identity?.confirmed === true, identity, badges };
}
export function badgeLabel(claim, org, eff) {
  const orgName = org?.name ?? 'organisation';
  switch (claim.claimType) {
    case 'ORGANISATION_IDENTITY':
      return 'Verified organisation';
    case 'ORGANISATION_DOMAIN':
      return `Official domain verified`;
    case 'ORGANISATION_ADMIN':
      return `Authorised ${orgName} administrator`;
    case 'CLUB_AFFILIATION':
    case 'GRASSROOTS_AFFILIATION':
    case 'FEDERATION_AFFILIATION':
    case 'AGENCY_AFFILIATION':
      return eff.historical
        ? `Former ${orgName}${claim.role ? ` ${claim.role}` : ''} · Verified history`
        : `Verified at ${orgName}`;
    case 'CLUB_ROLE':
    case 'AGENCY_ROLE':
      return eff.historical
        ? `Former ${orgName} ${claim.role ?? 'staff'} · Verified history`
        : `Role verified: ${claim.role ?? 'staff'}`;
    case 'LICENCE':
      // Only an authoritative source may put "verified" next to a licence; anything else is a reviewed credential.
      return assuranceForClaim(claim) === 'authoritative'
        ? `Licence verified: ${claim.metadata?.licenceType ?? 'credential'}`
        : `Credential reviewed: ${claim.metadata?.licenceType ?? 'credential'}`;
    default:
      return 'Verified claim';
  }
}

// ----------------------------------------------------------- one-time bootstrap
/**
 * Once per database: organisations already marked verified become an ORGANISATION_IDENTITY claim with method
 * `migration`, and a verified e-mail domain an ORGANISATION_DOMAIN claim. Nothing is upgraded to a state it never
 * legitimately reached.
 */
export function bootstrapVerification({ verification, orgs, now = Date.now() }) {
  if (verification.bootstrap.ran()) return 0;
  return verification.atomically(() => {
    let created = 0;
    const mkClaim = (fields) => {
      const id = `vclm-m-${verification.claims.count() + 1}`;
      const c = verification.claims.create({
        id,
        evidenceIds: [],
        metadata: {},
        validFrom: null,
        validUntil: null,
        current: true,
        role: null,
        organisationId: null,
        verifiedAt: null,
        verifiedBy: null,
        revokedAt: null,
        revokedBy: null,
        revocationReason: null,
        disputedAt: null,
        suspendedAt: null,
        reviewReasons: [],
        riskFlags: [],
        authorityType: null,
        authorityId: null,
        createdAt: now,
        updatedAt: now,
        ...fields,
      });
      verification.events.append({
        id: `vevt-m-${created + 1}`,
        ts: now,
        type: 'claim.created',
        claimId: c.id,
        subjectId: c.subjectId,
        orgId: c.organisationId,
        actorKind: 'system',
        actorId: null,
        actorName: 'migration',
        reason: 'M14 migration of pre-existing record',
        detail: `status: ${c.status}; method: ${c.verificationMethod ?? '—'}`,
      });
      created++;
      return c;
    };
    for (const o of orgs) {
      if (!o.verified) continue;
      mkClaim({
        subjectType: 'org',
        subjectId: o.id,
        claimType: 'ORGANISATION_IDENTITY',
        organisationId: o.id,
        status: 'verified',
        verificationMethod: 'migration',
        verifiedAt: now,
        verifiedBy: { kind: 'system', id: null },
        metadata: { migratedFrom: 'legacy org.verified boolean (set by Trust & Safety review)' },
      });
      if (o.emailDomainVerified && o.emailDomain) {
        const domain = normalizeDomain(o.emailDomain);
        if (!verification.domains.has(o.id, domain))
          verification.domains.add(o.id, {
            domain,
            status: 'verified',
            method: 'official_domain_email',
            verifiedAt: now,
            addedBy: 'migration',
          });
        mkClaim({
          subjectType: 'org',
          subjectId: o.id,
          claimType: 'ORGANISATION_DOMAIN',
          organisationId: o.id,
          status: 'verified',
          verificationMethod: 'migration',
          verifiedAt: now,
          metadata: { domain, migratedFrom: 'legacy emailDomainVerified challenge' },
        });
      }
    }
    verification.bootstrap.recordBootstrap(now, created);
    return created;
  });
}
