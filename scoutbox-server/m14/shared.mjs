// M14 shared — verification & trust core.
//
// Design contract (enforced here, at the server, never in a client):
//  * Verification is a set of INDEPENDENT CLAIMS, each recording WHAT was
//    established, HOW (method), by WHOM (authority) and on WHAT evidence.
//    There is no account-level `verified: true`.
//  * Uploaded documents are EVIDENCE, never truth: `document_submitted` can
//    never be the method of a claim in state `verified`.
//  * Every state transition is validated server-side against one map.
//  * Nobody can be the authoritative confirmer of their own claim.
//  * The engine is fully deterministic — no AI output participates in any
//    decision. Everything here is a pure function over stored records so it
//    can be unit-tested directly.
//  * M14 does NOT introduce a new age system: all age gates continue to use
//    the existing DOB/country isAdult() from domain.mjs.
import crypto from 'node:crypto';

// ------------------------------------------------------------- claim types
export const CLAIM_TYPES = [
  'PERSON_IDENTITY',        // this account belongs to the named individual
  'ORGANISATION_IDENTITY',  // this org account corresponds to the real organisation
  'ORGANISATION_DOMAIN',    // control of an approved official org domain
  'ORGANISATION_ADMIN',     // this person may administer the org on ScoutBox
  'CLUB_AFFILIATION',       // person ↔ organisation relationship
  'CLUB_ROLE',              // person → role → organisation
  'LICENCE',                // credential issued by an authoritative body
  'AGENCY_AFFILIATION',     // adult-only where existing rules require it
  'AGENCY_ROLE',
  'GRASSROOTS_AFFILIATION',
  'FEDERATION_AFFILIATION',
];

export const CLAIM_STATES = [
  'unverified', 'collecting_evidence', 'pending', 'automated_checks_passed',
  'requires_human_review', 'verified', 'rejected', 'expired', 'suspended',
  'revoked', 'disputed', 'superseded',
];

// Deterministic method identifiers (§4). document_submitted is EVIDENCE
// COLLECTION, never an authoritative method.
export const METHODS = [
  'official_domain_email', 'organisation_admin_confirmation',
  'authoritative_registry', 'federation_confirmation',
  'existing_verified_org_admin', 'scoutbox_manual_review',
  'document_submitted', 'reference_confirmation', 'migration',
];
// Methods that may accompany a transition INTO `verified`.
export const AUTHORITATIVE_METHODS = new Set([
  'official_domain_email',           // only proves domain control (ORGANISATION_DOMAIN)
  'organisation_admin_confirmation',
  'authoritative_registry',
  'federation_confirmation',
  'existing_verified_org_admin',
  'scoutbox_manual_review',
  'migration',                       // carries forward a previously-established fact, honestly labelled
]);

// ---------------------------------------------------------- state machine
// One map; applyTransition() is the ONLY way any M14 code changes a status.
export const VALID_TRANSITIONS = {
  unverified: ['collecting_evidence', 'pending'],
  collecting_evidence: ['pending', 'unverified'],
  pending: ['automated_checks_passed', 'requires_human_review', 'rejected', 'collecting_evidence'],
  automated_checks_passed: ['verified', 'requires_human_review', 'rejected', 'collecting_evidence'],
  requires_human_review: ['verified', 'rejected', 'collecting_evidence', 'suspended'],
  verified: ['expired', 'suspended', 'revoked', 'disputed', 'superseded'],
  expired: ['pending'],                       // reconfirmation restarts the pipeline
  suspended: ['verified', 'revoked'],         // reinstate or revoke — T&S / policy only
  disputed: ['verified', 'suspended', 'revoked'],
  rejected: [],                               // terminal: resubmission = NEW claim (supersedesClaimId)
  revoked: ['verified'],                      // reinstate where policy permits (T&S only, audited)
  superseded: [],
};

export function canTransition(from, to) {
  return (VALID_TRANSITIONS[from] ?? []).includes(to);
}

/** Validate + apply one transition. Returns null on success or an error code.
 *  Never mutates on failure. Mutation is additive: prior state lands in the
 *  claim history and the caller's verEvent — history is never rewritten. */
export function applyTransition(claim, to, { actorKind, actorId, method, reason, now = Date.now() } = {}) {
  if (!CLAIM_STATES.includes(to)) return 'UNKNOWN_STATE';
  if (claim.status === to) return 'ALREADY_IN_STATE';
  if (!canTransition(claim.status, to)) return 'ILLEGAL_TRANSITION';
  if (to === 'verified') {
    const m = method ?? claim.verificationMethod;
    if (!m || !AUTHORITATIVE_METHODS.has(m)) return 'METHOD_NOT_AUTHORITATIVE';
    if (m === 'official_domain_email' && !['ORGANISATION_DOMAIN'].includes(claim.claimType)) {
      // Domain control alone never equals employment/identity/org identity.
      return 'DOMAIN_CONTROL_INSUFFICIENT';
    }
  }
  if (['revoked', 'suspended', 'rejected'].includes(to) && !reason) return 'REASON_REQUIRED';
  claim.status = to;
  claim.updatedAt = now;
  if (to === 'verified') {
    claim.verificationMethod = method ?? claim.verificationMethod;
    claim.verifiedAt = claim.verifiedAt ?? now;
    claim.verifiedBy = { kind: actorKind ?? 'system', id: actorId ?? null };
    claim.suspendedAt = null;
    claim.disputedAt = null;
  }
  if (to === 'revoked') { claim.revokedAt = now; claim.revokedBy = { kind: actorKind, id: actorId ?? null }; claim.revocationReason = String(reason); claim.current = false; }
  if (to === 'suspended') { claim.suspendedAt = now; claim.suspendReason = String(reason); }
  if (to === 'disputed') claim.disputedAt = now;
  if (to === 'expired') claim.expiredAt = now;
  if (to === 'superseded') claim.current = false;
  return null;
}

// --------------------------------------------------- effective-claim engine
// A claim DISPLAYS as verified only if every condition holds at READ TIME
// (§51). Nothing trusts a cached boolean.
export function effectiveStatus(claim, { org = null, subjectRemoved = false, now = Date.now() } = {}) {
  const reasons = [];
  let status = claim.status;
  // Expiry applies to CURRENT claims. A closed period (current=false) is
  // finished history — it does not "expire", it remains a verified past fact.
  if (status === 'verified' && claim.current !== false && claim.validUntil && claim.validUntil < now) { status = 'expired'; reasons.push('VALID_UNTIL_PASSED'); }
  if (subjectRemoved && claim.current) reasons.push('SUBJECT_ACCOUNT_INACTIVE');
  const orgScoped = !!claim.organisationId;
  if (orgScoped) {
    if (!org) { reasons.push('ORGANISATION_MISSING'); }
    else {
      if (org.suspended) reasons.push('ORGANISATION_SUSPENDED');
      if (org.verification?.revokedAt) reasons.push('ORGANISATION_REVOKED');
      if (org.closedAt) reasons.push('ORGANISATION_CLOSED');
    }
  }
  // Historical (current=false but once verified with a closed period) stays
  // displayable AS HISTORY even when the person left — truth is not erased.
  const verifiedNow = status === 'verified' && reasons.length === 0;
  const verifiedHistorical = status === 'verified'
    && claim.current === false && !!claim.validUntil
    && !reasons.includes('ORGANISATION_REVOKED'); // fraud-revoked orgs stop lending history
  return {
    status,
    displayable: verifiedNow || verifiedHistorical,
    current: verifiedNow && claim.current !== false,
    historical: verifiedHistorical && !(verifiedNow && claim.current !== false),
    reasons,
  };
}

// ------------------------------------------------- email / domain helpers
export const FREE_MAIL_DOMAINS = /^(gmail|googlemail|hotmail|outlook|yahoo|icloud|aol|proton|protonmail|gmx|live|msn|mail|yandex|zoho)\./i;
export const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.dev',
  'yopmail.com', 'sharklasers.com', 'trashmail.com', 'dispostable.com',
]);
export function emailProblem(email) {
  const e = String(email ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e)) return 'EMAIL_SYNTAX';
  if (e.length > 254) return 'EMAIL_TOO_LONG';
  return null;
}
export function normalizeDomain(domain) {
  return String(domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split(':')[0];
}
export const domainOfEmail = (email) => normalizeDomain(String(email ?? '').split('@')[1] ?? '');
export const isFreeMail = (domain) => FREE_MAIL_DOMAINS.test(`${normalizeDomain(domain)}.`) || FREE_MAIL_DOMAINS.test(normalizeDomain(domain));
export const isDisposable = (domain) => DISPOSABLE_DOMAINS.has(normalizeDomain(domain));
/** True when `candidate` is the org domain or a subdomain of it. */
export function domainCovered(candidate, orgDomain) {
  const c = normalizeDomain(candidate), o = normalizeDomain(orgDomain);
  return !!c && !!o && (c === o || c.endsWith(`.${o}`));
}

// ------------------------------------------------------------ risk signals
// Deterministic flags (§26). Signals, NEVER conclusions: nothing downstream
// may describe a flag as fraud, and no flag alone rejects anything.
export function riskFlags(input) {
  const {
    email, orgDomains = [], applicantHadRecentRevocation = false,
    duplicateEvidenceHash = false, competingOrgClaims = 0, orgSuspended = false,
    conflictingActiveRoles = 0, requestsLastDay = 0, actorIsSubject = false,
    emailChallengeFails = 0, credentialReusedByOthers = false,
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
// §24: one deterministic engine answers CAN_AUTO_COMPLETE vs
// REQUIRES_HUMAN_REVIEW with reason codes. "Auto" here means "no ScoutBox
// (Trust & Safety) human needed" — an authorised ORGANISATION administrator
// confirming their own staff IS the authoritative source, not a fallback.
export const REVIEW_REASONS = [
  'ROOT_ORGANISATION_BOOTSTRAP', 'NO_AUTHORITATIVE_SOURCE', 'CONFLICTING_EVIDENCE',
  'IDENTITY_MISMATCH', 'DOMAIN_OWNERSHIP_AMBIGUOUS', 'DUPLICATE_ORGANISATION',
  'HIGH_RISK_ADMIN_CHANGE', 'DOCUMENT_AUTHENTICITY_UNCONFIRMED',
  'REGISTRY_AMBIGUOUS_MATCH', 'DISPUTED_CLAIM', 'SUSPECTED_FRAUD_SIGNALS',
  'MANUAL_EXCEPTION_REQUESTED',
];
export function decideReview(input) {
  const {
    claimType, orgHasActiveAuthority = false, isFirstOrgAdmin = false,
    duplicateOrg = false, conflictingEvidence = false, identityMismatch = false,
    domainAmbiguous = false, registryResult = null, disputed = false,
    highRiskAdminChange = false, manualException = false, riskFlagCount = 0,
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
  const affiliationLike = ['CLUB_AFFILIATION', 'CLUB_ROLE', 'AGENCY_AFFILIATION', 'AGENCY_ROLE', 'GRASSROOTS_AFFILIATION', 'FEDERATION_AFFILIATION'].includes(claimType);
  if (affiliationLike && !orgHasActiveAuthority) reasons.push('NO_AUTHORITATIVE_SOURCE');
  if (['PERSON_IDENTITY', 'LICENCE'].includes(claimType) && documentOnly && registryResult !== 'match') {
    reasons.push('DOCUMENT_AUTHENTICITY_UNCONFIRMED');
  }
  return { decision: reasons.length ? 'REQUIRES_HUMAN_REVIEW' : 'CAN_AUTO_COMPLETE', reasons };
}

// ------------------------------------------------------ evidence handling
export const EVIDENCE_TYPES = ['official_email', 'document', 'registry_result', 'organisation_confirmation', 'federation_confirmation', 'reference', 'existing_claim'];
export const EVIDENCE_VISIBILITY = ['trust_and_safety', 'organisation_internal', 'subject_only'];
export const EVIDENCE_MIME_ALLOW = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
export const EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;
export function evidenceFileProblem({ mime, bytes, filename }) {
  if (!EVIDENCE_MIME_ALLOW.has(String(mime))) return 'FILE_TYPE_NOT_ALLOWED';
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > EVIDENCE_MAX_BYTES) return 'FILE_TOO_LARGE';
  const name = String(filename ?? '');
  if (/[\\/]|\.\./.test(name)) return 'FILENAME_INVALID'; // no traversal, ever
  if (/\.(exe|js|sh|bat|cmd|com|scr|msi|dll|svg|html?)$/i.test(name)) return 'FILE_TYPE_NOT_ALLOWED';
  return null;
}
export function evidenceCompleteness(claimType, evidenceTypes) {
  const have = new Set(evidenceTypes);
  const need = {
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

// -------------------------------------------------------------- tokens (§34)
// Cryptographically random, hashed at rest, expiring, single-use, bound to a
// purpose AND an address/subject. The plain secret exists only in the email
// that carries it — it is never logged and never stored.
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export function mintToken(db, nextId, { purpose, email = null, subjectKind = null, subjectId = null, orgId = null, refId = null, ttlMs = 30 * 60_000 }) {
  const secret = crypto.randomBytes(24).toString('base64url');
  db.verTokens.push({
    id: nextId('vtk'), hash: sha256(secret), purpose, email: email ? String(email).toLowerCase() : null,
    subjectKind, subjectId, orgId, refId, createdAt: Date.now(), expiresAt: Date.now() + ttlMs, usedAt: null,
  });
  return secret;
}
/** Single-use consumption with exact failure codes. Marks used on SUCCESS only. */
export function consumeToken(db, { purpose, secret, email = null, subjectId = null }) {
  const t = db.verTokens.find((x) => x.hash === sha256(secret ?? ''));
  if (!t) return { error: 'TOKEN_UNKNOWN' };
  if (t.purpose !== purpose) return { error: 'TOKEN_WRONG_PURPOSE' };
  if (t.usedAt) return { error: 'TOKEN_ALREADY_USED' };
  if (t.expiresAt < Date.now()) return { error: 'TOKEN_EXPIRED' };
  if (t.email && email && t.email !== String(email).toLowerCase()) return { error: 'TOKEN_WRONG_ADDRESS' };
  if (t.subjectId && subjectId && t.subjectId !== subjectId) return { error: 'TOKEN_WRONG_ACCOUNT' };
  t.usedAt = Date.now();
  return { token: t };
}

// ------------------------------------------- verification admin hierarchy
export const VER_LEVELS = ['verification_viewer', 'verification_reviewer', 'verification_admin', 'verification_root_admin'];
export const verLevelRank = (level) => VER_LEVELS.indexOf(level);
export function verLevelFor(db, orgId, userId) {
  const rows = db.verAdmins.filter((a) => a.orgId === orgId && a.userId === userId && a.status === 'active');
  if (!rows.length) return null;
  return rows.reduce((best, a) => (verLevelRank(a.level) > verLevelRank(best) ? a.level : best), rows[0].level);
}
export function hasVerLevel(db, orgId, userId, atLeast) {
  const lvl = verLevelFor(db, orgId, userId);
  return lvl !== null && verLevelRank(lvl) >= verLevelRank(atLeast);
}

// ------------------------------------------------ organisation lifecycle
export function orgVerificationStatus(org, db) {
  if (!org) return 'unverified';
  if (org.closedAt) return 'closed';
  if (org.verification?.revokedAt) return 'revoked';
  if (org.suspended) return 'suspended';
  if (org.verified) return 'verified';
  const pendingRoot = db?.verRootRequests?.some((r) => (r.existingOrgId === org.id || r.resultOrgId === org.id) && ['pending', 'requires_human_review', 'collecting_evidence'].includes(r.status));
  return pendingRoot ? 'pending' : 'unverified';
}
/** Can this org currently mint NEW effective verified affiliation claims? */
export function orgCanAttest(org, db) {
  return orgVerificationStatus(org, db) === 'verified';
}

// --------------------------------------------------------- public projection
// THE one safe projector (§50). Everything any client shows publicly about
// verification flows through here. It never returns evidence, emails,
// reviewer notes, risk flags, or internal review state.
export function claimProvenanceLabel(claim, orgName) {
  switch (claim.verificationMethod) {
    case 'organisation_admin_confirmation':
      return `Confirmed by an authorised ${orgName ?? 'organisation'} administrator`;
    case 'existing_verified_org_admin':
      return `Confirmed by an existing verified ${orgName ?? 'organisation'} administrator`;
    case 'authoritative_registry': return 'Confirmed against an authoritative registry';
    case 'federation_confirmation': return 'Confirmed by the governing federation';
    case 'official_domain_email': return 'Confirmed control of the official organisation domain';
    case 'scoutbox_manual_review': return 'Reviewed and confirmed by ScoutBox Trust & Safety';
    case 'migration': return 'Carried forward from a previously established ScoutBox verification';
    default: return 'Not independently verified';
  }
}
const CLAIM_BADGE_KIND = {
  PERSON_IDENTITY: 'identity', ORGANISATION_IDENTITY: 'organisation',
  ORGANISATION_DOMAIN: 'domain', ORGANISATION_ADMIN: 'admin',
  CLUB_AFFILIATION: 'affiliation', CLUB_ROLE: 'role', LICENCE: 'licence',
  AGENCY_AFFILIATION: 'affiliation', AGENCY_ROLE: 'role',
  GRASSROOTS_AFFILIATION: 'affiliation', FEDERATION_AFFILIATION: 'affiliation',
};
export function toPublicVerificationProfile({ subjectType, subjectId, claims, orgsById = new Map(), db = null, now = Date.now() }) {
  const badges = [];
  let identityVerified = false;
  for (const claim of claims) {
    const org = claim.organisationId ? orgsById.get(claim.organisationId) ?? null : null;
    const eff = effectiveStatus(claim, { org, now });
    if (!eff.displayable) continue;
    const y = (ms) => (ms ? new Date(ms).getFullYear() : null);
    if (claim.claimType === 'PERSON_IDENTITY') { identityVerified = true; continue; }
    badges.push({
      kind: CLAIM_BADGE_KIND[claim.claimType] ?? 'claim',
      claimType: claim.claimType,
      label: badgeLabel(claim, org, eff),
      organisation: org ? { id: org.id, name: org.name } : null,
      role: claim.role ?? null,
      current: eff.current,
      historical: eff.historical,
      period: claim.validFrom ? { from: y(claim.validFrom), to: claim.validUntil ? y(claim.validUntil) : null } : null,
      verifiedAt: claim.verifiedAt ?? null,
      provenance: claimProvenanceLabel(claim, org?.name),
    });
  }
  return { subjectType, subjectId, identityVerified, badges };
}
export function badgeLabel(claim, org, eff) {
  const orgName = org?.name ?? 'organisation';
  switch (claim.claimType) {
    case 'ORGANISATION_IDENTITY': return 'Verified organisation';
    case 'ORGANISATION_DOMAIN': return `Official domain verified`;
    case 'ORGANISATION_ADMIN': return `Authorised ${orgName} administrator`;
    case 'CLUB_AFFILIATION': case 'GRASSROOTS_AFFILIATION': case 'FEDERATION_AFFILIATION': case 'AGENCY_AFFILIATION':
      return eff.historical
        ? `Former ${orgName}${claim.role ? ` ${claim.role}` : ''} · Verified history`
        : `Verified at ${orgName}`;
    case 'CLUB_ROLE': case 'AGENCY_ROLE':
      return eff.historical
        ? `Former ${orgName} ${claim.role ?? 'staff'} · Verified history`
        : `Role verified: ${claim.role ?? 'staff'}`;
    case 'LICENCE': return `Licence verified: ${claim.metadata?.licenceType ?? 'credential'}`;
    default: return 'Verified claim';
  }
}

// ----------------------------------------------------------- migrations
export function migrateM14(db) {
  db.verClaims ??= [];
  db.verEvents ??= [];        // append-only — NOTHING ever mutates or deletes a row
  db.verEvidence ??= [];
  db.verTokens ??= [];        // hashed secrets only
  db.verAdmins ??= [];
  db.verRootRequests ??= [];
  db.verDisputes ??= [];
  db.verReferences ??= [];
  db.verPlayerInvites ??= [];
  db.verConflicts ??= [];
  db.verDomainRequests ??= [];
  db.verMigrated ??= {};
  for (const o of db.orgs ?? []) {
    o.verification ??= { domains: [], revokedAt: null, orgType: o.type === 'agency' ? 'agency' : (o.level === 'grassroots' ? 'grassroots club' : 'professional club') };
  }

  // ---- HONEST one-time migrations. Nothing is upgraded to a state it never
  // legitimately reached; provenance says exactly where each record came from.
  const now = Date.now();
  const mkClaim = (fields) => {
    const c = {
      id: `vclm-m-${db.verClaims.length + 1}`, evidenceIds: [], metadata: {}, history: [],
      validFrom: null, validUntil: null, current: true, role: null, organisationId: null,
      verifiedAt: null, verifiedBy: null, revokedAt: null, revokedBy: null, revocationReason: null,
      disputedAt: null, suspendedAt: null, supersedesClaimId: null, reviewReasons: [], riskFlags: [],
      createdAt: now, updatedAt: now, ...fields,
    };
    db.verClaims.push(c);
    db.verEvents.push({ id: `vevt-m-${db.verEvents.length + 1}`, ts: now, type: 'claim.created', claimId: c.id, subjectId: c.subjectId, orgId: c.organisationId, actorKind: 'system', actorId: null, actorName: 'migration', reason: 'M14 migration of pre-existing record', before: null, after: { status: c.status, method: c.verificationMethod } });
    return c;
  };

  if (!db.verMigrated.m14) {
    // 1. Orgs already marked verified by Trust & Safety (legacy boolean set
    //    via POST /admin/clubs/:id/verification — a human decision) become an
    //    ORGANISATION_IDENTITY claim with method `migration`, preserving that
    //    the original establishment was T&S review, not self-service.
    for (const o of db.orgs) {
      if (o.verified) {
        mkClaim({
          subjectType: 'org', subjectId: o.id, claimType: 'ORGANISATION_IDENTITY',
          organisationId: o.id, status: 'verified', verificationMethod: 'migration',
          verifiedAt: now, verifiedBy: { kind: 'system', id: null },
          metadata: { migratedFrom: 'legacy org.verified boolean (set by Trust & Safety review)' },
        });
        if (o.emailDomainVerified && o.emailDomain) {
          o.verification.domains.push({ domain: normalizeDomain(o.emailDomain), status: 'verified', method: 'official_domain_email', verifiedAt: now, addedBy: 'migration' });
          mkClaim({
            subjectType: 'org', subjectId: o.id, claimType: 'ORGANISATION_DOMAIN',
            organisationId: o.id, status: 'verified', verificationMethod: 'migration',
            verifiedAt: now, metadata: { domain: normalizeDomain(o.emailDomain), migratedFrom: 'legacy emailDomainVerified challenge' },
          });
        }
      }
    }
    // 2. F10 representation credentials: "uploaded document, review pending"
    //    becomes a LICENCE claim in `pending` with method `document_submitted`
    //    — NO false upgrade to verified (§48). A credential T&S had already
    //    document-reviewed stays requires_human_review-resolved as a MANUAL
    //    document review, which is still NOT registry-verified.
    for (const r of db.representations ?? []) {
      if (!r.credential) continue;
      mkClaim({
        subjectType: 'org', subjectId: r.agencyOrgId, claimType: 'LICENCE',
        organisationId: r.agencyOrgId, status: 'pending', verificationMethod: 'document_submitted',
        metadata: {
          licenceType: 'agency credential', note: r.credential.note ?? null, representationId: r.id,
          documentReviewed: r.credential.reviewStatus === 'reviewed_valid'
            ? 'document reviewed by Trust & Safety — a document review, not an independent register check' : null,
        },
      });
    }
    db.verMigrated.m14 = { at: now, claims: db.verClaims.length };
  }
}

// ------------------------------------------------------- claims index (§69)
// Verification badges appear on common list reads; a per-request full scan of
// verClaims would be an N+1. One in-memory index, rebuilt on boot, updated on
// every claim creation (claims never change subject).
export function buildClaimIndex(db) {
  const bySubject = new Map(); // `${subjectType}:${subjectId}` → claim[]
  const byAuthority = new Map(); // authority user id → claim[]
  const add = (map, key, c) => { if (!key) return; const arr = map.get(key) ?? []; arr.push(c); map.set(key, arr); };
  for (const c of db.verClaims) {
    add(bySubject, `${c.subjectType}:${c.subjectId}`, c);
    if (c.authorityType === 'org_admin' && c.authorityId) add(byAuthority, c.authorityId, c);
  }
  return {
    bySubject, byAuthority,
    claimsFor: (subjectType, subjectId) => bySubject.get(`${subjectType}:${subjectId}`) ?? [],
    register: (c) => { add(bySubject, `${c.subjectType}:${c.subjectId}`, c); },
    registerAuthority: (c) => { if (c.authorityType === 'org_admin' && c.authorityId && !(byAuthority.get(c.authorityId) ?? []).includes(c)) add(byAuthority, c.authorityId, c); },
    claimsByAuthority: (userId) => byAuthority.get(userId) ?? [],
  };
}
