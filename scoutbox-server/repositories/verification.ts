/**
 * Verification claims and the records around them.
 *
 * Records: staff and organisation claims (with their review-reason and risk-flag codes and their evidence links), the
 * append-only verification event log, evidence records (verification documents, email and registry proofs, and the
 * signing and transaction documents other domains file through the same vault), one-time tokens (hashes only),
 * verification administrators, root-authority transfers, root organisation applications (with their codes), claim
 * disputes, coach references, squad invitations by code, conflict-of-interest declarations, domain requests (with their
 * codes) and an organisation's verified domains. Every field is a typed
 * column with its vocabulary and length CHECKs; there are no side columns and no JSON columns: a claim's `metadata` and
 * an evidence record's `meta` are fixed sets of optional typed columns, and an event's before/after payload is one line
 * of text (`detail`). A record the columns cannot hold is refused with its id.
 *
 * Writes (repositories/writes.ts). A record is created whole and must read back as written, then changes only through
 * named acts (`claims.move`, `tokens.use`, `admins.revoke`, `rootRequests.approve`, …), each an UPDATE of named columns
 * or an INSERT of code rows, joined into the open unit of work, the caller's open transaction, or a transaction of their
 * own. A claim's status moves only along CLAIM_TRANSITIONS, from the status its caller decided on, guarded in SQL; every
 * other act is guarded by the state it leaves (a token is used once, a dispute resolved once). Risk flags only gain
 * codes. Events are only inserted (`events.append`). Evidence created with `claimIds` is linked to those claims at once
 * (the claim's `evidenceIds` grow by one row each). A root application's evidence is the evidence whose
 * `meta.rootRequest` names it. The columns and keys are the only check on stored values.
 *
 * Queries decode deep-frozen records in insertion (rowid) order unless they say otherwise. Modules receive them as
 * `verificationReads`.
 *
 * Records and inputs are typed from the field specs (`RecordOf`, repositories/fieldSpecs.ts), so a column and the field
 * it holds are described once.
 *
 * References. Player ids (references, invitations, tokens) carry no key: tolerant, as recruitment and scouting. Org ids
 * → orgs and staff ids → org_users are immediate RESTRICT keys; claim, evidence, root-request and reference keys inside
 * the domain are immediate RESTRICT keys. Composite keys hold two rules between rows: a reference's provenance is a
 * claim of its own coach at its own organisation, and a new version supersedes a reference of the same player, coach
 * and organisation. Polymorphic ids (a claim's subject and authority, an event's subject, a token's subject and ref, an
 * invitation's inviter of record 'trust_safety') carry none.
 */
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import {
  isPlainObject,
  describe,
  text,
  int,
  bool,
  oneOf,
  group,
  quote,
  tableDdl,
  decode,
  insertSql,
  type FieldOptions,
  type RecordOf,
  type Spec,
} from './fieldSpecs.ts';
import { migrationApplied, childRowsOf, operationOn, type Row, type UnitParticipant } from './database.ts';
import { refusal } from './identityRules.ts';
import { writeKit, type InputWith } from './writes.ts';
import { deepFreeze, type DeepReadonly } from '../domains/platform/values.ts';

export const VERIFICATION_MIGRATION = '0023_verification';
export const VERIFICATION_COLLECTIONS = Object.freeze([
  'verClaims',
  'verEvents',
  'verEvidence',
  'verTokens',
  'verAdmins',
  'verRootTransfers',
  'verRootRequests',
  'verDisputes',
  'verReferences',
  'verPlayerInvites',
  'verConflicts',
  'verDomainRequests',
  'orgVerifiedDomains',
] as const);
export type VerificationCollection = (typeof VERIFICATION_COLLECTIONS)[number];

// ------------------------------------------------------------------ vocabularies (one definition; the domain module imports them)
export const CLAIM_TYPES = Object.freeze([
  'PERSON_IDENTITY',
  'ORGANISATION_IDENTITY',
  'ORGANISATION_DOMAIN',
  'ORGANISATION_ADMIN',
  'CLUB_AFFILIATION',
  'CLUB_ROLE',
  'LICENCE',
  'AGENCY_AFFILIATION',
  'AGENCY_ROLE',
  'GRASSROOTS_AFFILIATION',
  'FEDERATION_AFFILIATION',
] as const);
export const CLAIM_STATES = Object.freeze([
  'unverified',
  'collecting_evidence',
  'pending',
  'automated_checks_passed',
  'requires_human_review',
  'verified',
  'rejected',
  'expired',
  'suspended',
  'revoked',
  'disputed',
  'superseded',
] as const);
export type ClaimType = (typeof CLAIM_TYPES)[number];
export type ClaimState = (typeof CLAIM_STATES)[number];
/** The claim state machine: the statuses each status may move to (domains/verification/claims/shared.mjs judges a move). */
export const CLAIM_TRANSITIONS: Readonly<Record<ClaimState, readonly ClaimState[]>> = Object.freeze({
  unverified: ['collecting_evidence', 'pending'],
  collecting_evidence: ['pending', 'unverified'],
  pending: ['automated_checks_passed', 'requires_human_review', 'rejected', 'collecting_evidence'],
  automated_checks_passed: ['verified', 'requires_human_review', 'rejected', 'collecting_evidence'],
  requires_human_review: ['verified', 'rejected', 'collecting_evidence', 'suspended'],
  verified: ['expired', 'suspended', 'revoked', 'disputed', 'superseded'],
  expired: ['pending'], // reconfirmation restarts the pipeline
  suspended: ['verified', 'revoked'], // reinstate or revoke: T&S / policy only
  disputed: ['verified', 'suspended', 'revoked'],
  rejected: [], // terminal: a resubmission is a new claim
  revoked: ['verified'], // reinstated where policy permits (T&S only, audited)
  superseded: [],
});
export const METHODS = Object.freeze([
  'official_domain_email',
  'organisation_admin_confirmation',
  'authoritative_registry',
  'federation_confirmation',
  'existing_verified_org_admin',
  'scoutbox_manual_review',
  'document_submitted',
  'reference_confirmation',
  'migration',
] as const);
export const REVIEW_REASONS = Object.freeze([
  'ROOT_ORGANISATION_BOOTSTRAP',
  'NO_AUTHORITATIVE_SOURCE',
  'CONFLICTING_EVIDENCE',
  'IDENTITY_MISMATCH',
  'DOMAIN_OWNERSHIP_AMBIGUOUS',
  'DUPLICATE_ORGANISATION',
  'HIGH_RISK_ADMIN_CHANGE',
  'DOCUMENT_AUTHENTICITY_UNCONFIRMED',
  'REGISTRY_AMBIGUOUS_MATCH',
  'DISPUTED_CLAIM',
  'SUSPECTED_FRAUD_SIGNALS',
  'MANUAL_EXCEPTION_REQUESTED',
] as const);
/** The codes a review-reason list can hold: the engine's reasons plus the registry's unreadable-record reason. */
export const REVIEW_CODES = Object.freeze([...REVIEW_REASONS, 'REGISTRY_RECORD_UNREADABLE'] as const);
export const RISK_FLAGS = Object.freeze([
  'DISPOSABLE_EMAIL',
  'FREE_EMAIL_PROVIDER',
  'ORG_DOMAIN_MISMATCH',
  'REPEATED_EMAIL_CHALLENGE_FAILURES',
  'COMPETING_ORGANISATION_CLAIMS',
  'CREDENTIAL_REUSED_ACROSS_USERS',
  'DUPLICATE_EVIDENCE_HASH',
  'RECENT_REVOCATION_REAPPLY',
  'ORGANISATION_SUSPENDED',
  'CONFLICTING_ACTIVE_ROLES',
  'UNUSUAL_MASS_ACTIVITY',
  'SELF_VERIFICATION_ATTEMPT',
] as const);
export const VER_LEVELS = Object.freeze([
  'verification_viewer',
  'verification_reviewer',
  'verification_admin',
  'verification_root_admin',
] as const);
export const EVIDENCE_TYPES = Object.freeze([
  'official_email',
  'document',
  'registry_result',
  'organisation_confirmation',
  'federation_confirmation',
  'reference',
  'existing_claim',
] as const);
export const EVIDENCE_VISIBILITY = Object.freeze([
  'trust_and_safety',
  'organisation_internal',
  'subject_only',
] as const);
export const EVIDENCE_MIMES = Object.freeze(['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const);
export const ROOT_ORG_TYPES = Object.freeze([
  'professional club',
  'academy',
  'grassroots club',
  'federation/association',
  'agency',
  'other approved football organisation',
] as const);
export const CONFLICT_KINDS = Object.freeze([
  'family_relationship',
  'agent_relationship',
  'financial_interest',
  'coaching_relationship',
  'other',
] as const);
export const TOKEN_PURPOSES = Object.freeze(['work_email', 'domain_email', 'player_invite', 'root_email'] as const);
export const ATTRIBUTIONS = Object.freeze(['authenticated_reviewer', 'declared_reviewer', 'shared_admin_key'] as const);
export const IDENTITY_LINKS = Object.freeze([
  'trust_safety_selection',
  'provisioned_new_user',
  'verified_work_email',
] as const);
export const EVENT_TYPES = Object.freeze([
  'claim.created',
  ...(CLAIM_STATES.filter((s) => s !== 'unverified').map((s) => `claim.${s}`) as `claim.${Exclude<
    ClaimState,
    'unverified'
  >}`[]),
  'claim.unverified',
  'claim.reinstated',
  'claim.corrected',
  'review.requested',
  'review.assigned',
  'review.approved',
  'review.rejected',
  'automated_check.passed',
  'automated_check.failed',
  'evidence.added',
  'evidence.accessed',
  'email.challenge_sent',
  'email.challenge_passed',
  'security.self_verification_blocked',
  'organisation.domain_added',
  'organisation.domain_verified',
  'organisation.domain_removed',
  'admin.invited',
  'admin.accepted',
  'admin.revoked',
] as const);
export type VerificationMethod = (typeof METHODS)[number];
export type ReviewReason = (typeof REVIEW_REASONS)[number];
export type ReviewCode = (typeof REVIEW_CODES)[number];
export type RiskFlag = (typeof RISK_FLAGS)[number];
export type VerificationLevel = (typeof VER_LEVELS)[number];
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export type EvidenceVisibility = (typeof EVIDENCE_VISIBILITY)[number];
export type EvidenceMime = (typeof EVIDENCE_MIMES)[number];
export type RootOrgType = (typeof ROOT_ORG_TYPES)[number];
export type ConflictKind = (typeof CONFLICT_KINDS)[number];
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];
export type Attribution = (typeof ATTRIBUTIONS)[number];
export type IdentityLink = (typeof IDENTITY_LINKS)[number];
export type VerificationEventType = (typeof EVENT_TYPES)[number];
/** Text limits: the routes check or shorten to these; the columns refuse anything longer. */
export const VERIFICATION_LIMITS = Object.freeze({
  id: 80,
  name: 200,
  role: 60,
  reason: 600,
  note: 400,
  email: 254,
  domain: 253,
  licenceType: 80,
  issuer: 80,
  identifier: 60,
  holderName: 80,
  display: 300,
  provider: 60,
  website: 200,
  orgName: 120,
  country: 40,
  federation: 80,
  applicantName: 80,
  applicantRole: 60,
  officialContact: 200,
  decisionReason: 400,
  appointedReason: 300,
  flaggedReason: 300,
  assignedTo: 60,
  migratedFrom: 200,
  documentReviewed: 200,
  via: 60,
  filename: 120,
  source: 60,
  label: 120,
  relationship: 80,
  capacity: 120,
  strengths: 500,
  development: 500,
  summary: 800,
  withdrawReason: 300,
  inviteeName: 80,
  squad: 60,
  subject: 120,
  requestId: 120,
  detail: 1000,
  resolution: 320,
  registryDate: 40,
});
const L = VERIFICATION_LIMITS;

// ------------------------------------------------------------------ field specs (one description drives typing, rows and decoding)
const idf = <const K extends string, const O extends FieldOptions = {}>(k: K, c: string, o: O = {} as O) =>
  text(k, c, L.id, o);
const BY_KINDS = ['system', 'org_user', 'org_admin', 'trust_safety'] as const;

const CLAIM_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  oneOf('subjectType', 'subject_kind', ['user', 'org'], { req: true }),
  idf('subjectId', 'subject_id', { req: true, nonEmpty: true }),
  oneOf('claimType', 'claim_type', CLAIM_TYPES, { req: true }),
  idf('organisationId', 'organisation_id'),
  text('role', 'role', L.role),
  oneOf('status', 'status', CLAIM_STATES, { req: true }),
  int('validFrom', 'valid_from'),
  int('validUntil', 'valid_until'),
  bool('current', 'current', { req: true }),
  oneOf('verificationMethod', 'verification_method', METHODS),
  oneOf('authorityType', 'authority_kind', ['org_admin', 'trust_safety']),
  idf('authorityId', 'authority_id'),
  int('createdAt', 'created_at', { req: true }),
  int('updatedAt', 'updated_at', { req: true }),
  int('verifiedAt', 'verified_at'),
  group('verifiedBy', [oneOf('kind', 'verified_by_kind', BY_KINDS, { req: true }), idf('id', 'verified_by_id')], {
    nullable: true,
  }),
  int('revokedAt', 'revoked_at'),
  group('revokedBy', [oneOf('kind', 'revoked_by_kind', BY_KINDS, { req: true }), idf('id', 'revoked_by_id')], {
    nullable: true,
  }),
  text('revocationReason', 'revocation_reason', L.reason),
  int('suspendedAt', 'suspended_at'),
  text('suspendReason', 'suspend_reason', L.reason),
  int('disputedAt', 'disputed_at'),
  int('expiredAt', 'expired_at'),
  group(
    'metadata',
    [
      text('declaredName', 'declared_name', L.name),
      idf('pairId', 'pair_id'),
      int('requestedStart', 'requested_start'),
      text('workEmail', 'work_email', L.email),
      oneOf('domainControl', 'domain_control', ['passed']),
      bool('domainCoveredByOrg', 'domain_covered_by_org'),
      text('domain', 'domain', L.domain),
      text('licenceType', 'licence_type', L.licenceType),
      text('issuer', 'issuer', L.issuer),
      text('identifier', 'identifier', L.identifier),
      text('holderName', 'holder_name', L.holderName),
      text('display', 'display', L.display),
      group(
        'registry',
        [
          text('provider', 'registry_provider', L.provider, { req: true }),
          oneOf('state', 'registry_state', ['not_configured', 'temporarily_unavailable', 'unsupported']),
          oneOf('result', 'registry_result', ['match', 'no_match', 'unreadable_record']),
          int('checkedAt', 'registry_checked_at', { req: true }),
          text('reference', 'registry_reference', L.identifier),
        ],
        { nullable: true, sparse: true },
      ),
      idf('rootRequest', 'root_request_id'),
      oneOf('orgType', 'org_type', ROOT_ORG_TYPES),
      text('website', 'website', L.website),
      oneOf('level', 'admin_level', VER_LEVELS),
      oneOf('identityLink', 'identity_link', IDENTITY_LINKS),
      text('appointedReason', 'appointed_reason', L.appointedReason),
      text('via', 'via', L.via),
      group(
        'flaggedForReview',
        [int('at', 'flagged_at', { req: true }), text('reason', 'flagged_reason', L.flaggedReason, { req: true })],
        { nullable: true },
      ),
      text('migratedFrom', 'migrated_from', L.migratedFrom),
      text('note', 'note', L.note),
      idf('representationId', 'representation_id'),
      text('documentReviewed', 'document_reviewed', L.documentReviewed),
      text('assignedTo', 'assigned_to', L.assignedTo),
      int('expiryWarned', 'expiry_warned_at'),
    ],
    { sparse: true },
  ),
] as const;
const EVENT_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  int('ts', 'occurred_at', { req: true }),
  oneOf('type', 'type', EVENT_TYPES, { req: true }),
  oneOf('actorKind', 'actor_kind', ['org_user', 'system', 'trust_safety'], { req: true }),
  idf('actorId', 'actor_id'),
  text('actorName', 'actor_name', L.name),
  idf('actorOrgId', 'actor_org_id'),
  text('requestId', 'request_id', L.requestId),
  oneOf('attribution', 'attribution', ATTRIBUTIONS),
  idf('claimId', 'claim_id'),
  idf('subjectId', 'subject_id'),
  idf('orgId', 'org_id'),
  text('detail', 'detail', L.detail),
  text('reason', 'reason', L.reason),
] as const;
const EVIDENCE_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  oneOf('type', 'type', EVIDENCE_TYPES, { req: true }),
  text('source', 'source', L.source, { req: true, nonEmpty: true }),
  oneOf('suppliedByKind', 'supplied_by_kind', ['org_user', 'applicant', 'system'], { req: true }),
  idf('suppliedById', 'supplied_by_id'),
  idf('orgId', 'org_id'),
  int('receivedAt', 'received_at', { req: true }),
  idf('mediaId', 'media_id'),
  text('sha256', 'sha256', 64),
  oneOf('mime', 'mime', EVIDENCE_MIMES),
  int('bytes', 'bytes'),
  text('filename', 'filename', L.filename),
  group(
    'meta',
    [
      text('note', 'note', L.note),
      text('domain', 'domain', L.domain),
      bool('domainCoveredByOrg', 'domain_covered_by_org'),
      text('addressHash', 'address_hash', 64),
      idf('rootRequest', 'root_request_id'),
      text('identifier', 'identifier', L.identifier),
      text('licenceType', 'licence_type', L.licenceType),
      text('validUntil', 'registry_valid_until', L.registryDate),
      idf('signingPackageId', 'signing_package_id'),
      oneOf('signingDocumentKind', 'signing_document_kind', ['signing', 'executed']),
      text('label', 'label', L.label),
    ],
    { sparse: true },
  ),
  group(
    'checks',
    [
      oneOf('malwareScan', 'check_malware_scan', ['not_configured'], { req: true }),
      oneOf('contentSignature', 'check_content_signature', ['matched_claimed_type']),
    ],
    { sparse: true },
  ),
  oneOf('retention', 'retention', ['until_claim_resolution', 'until_signing_resolution'], { req: true }),
  oneOf('visibility', 'visibility', EVIDENCE_VISIBILITY, { req: true }),
  int('expiresAt', 'expires_at'),
] as const;
const TOKEN_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  text('hash', 'token_hash', 64, { req: true, nonEmpty: true }),
  oneOf('purpose', 'purpose', TOKEN_PURPOSES, { req: true }),
  text('email', 'email', L.email),
  oneOf('subjectKind', 'subject_kind', ['org_user', 'player']),
  idf('subjectId', 'subject_id'),
  idf('orgId', 'org_id'),
  idf('refId', 'ref_id'),
  int('createdAt', 'created_at', { req: true }),
  int('expiresAt', 'expires_at', { req: true }),
  int('usedAt', 'used_at'),
  int('attemptsFailed', 'attempts_failed', { req: true, def: 0 }),
] as const;
const ADMIN_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  idf('orgId', 'org_id', { req: true, nonEmpty: true }),
  idf('userId', 'user_id', { req: true, nonEmpty: true }),
  oneOf('level', 'level', VER_LEVELS, { req: true }),
  oneOf('status', 'status', ['active', 'revoked'], { req: true }),
  idf('invitedBy', 'invited_by', { req: true, nonEmpty: true }),
  int('createdAt', 'created_at', { req: true }),
  int('acceptedAt', 'accepted_at'),
  int('revokedAt', 'revoked_at'),
  idf('revokedBy', 'revoked_by'),
] as const;
const TRANSFER_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  idf('orgId', 'org_id', { req: true, nonEmpty: true }),
  idf('toUserId', 'to_user_id', { req: true, nonEmpty: true }),
  idf('proposedBy', 'proposed_by', { req: true, nonEmpty: true }),
  oneOf('status', 'status', ['pending', 'approved'], { req: true }),
  int('createdAt', 'created_at', { req: true }),
  idf('approvedBy', 'approved_by'),
  int('approvedAt', 'approved_at'),
] as const;
const PF = ['passed', 'flagged'] as const;
const ROOT_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  oneOf('status', 'status', ['collecting_evidence', 'requires_human_review', 'approved', 'rejected'], { req: true }),
  text('orgName', 'org_name', L.orgName, { req: true, nonEmpty: true }),
  oneOf('orgType', 'org_type', ROOT_ORG_TYPES, { req: true }),
  text('country', 'country', L.country, { req: true }),
  text('federation', 'federation', L.federation),
  text('website', 'website', L.website, { req: true }),
  text('domain', 'domain', L.domain, { req: true }),
  text('applicantName', 'applicant_name', L.applicantName, { req: true, nonEmpty: true }),
  text('applicantRole', 'applicant_role', L.applicantRole, { req: true }),
  text('workEmail', 'work_email', L.email, { req: true, nonEmpty: true }),
  text('officialContact', 'official_contact', L.officialContact),
  group('declarations', [bool('authorised', 'declared_authorised', { req: true })], { nullable: true }),
  group('checks', [
    oneOf('emailSyntax', 'check_email_syntax', ['passed'], { req: true }),
    oneOf('emailDomainAlignment', 'check_email_domain_alignment', ['passed', 'mismatch'], { req: true }),
    oneOf('freeEmailProvider', 'check_free_email_provider', PF, { req: true }),
    oneOf('disposableEmail', 'check_disposable_email', PF, { req: true }),
    text('domainNormalized', 'check_domain_normalized', L.domain + 10, { req: true }),
    oneOf('dnsOwnership', 'check_dns_ownership', ['not_configured'], { req: true }),
    oneOf('duplicateOrganisation', 'check_duplicate_organisation', PF, { req: true }),
    oneOf('duplicateRequest', 'check_duplicate_request', PF, { req: true }),
    oneOf('domainAlreadyVerifiedElsewhere', 'check_domain_already_verified_elsewhere', PF, { req: true }),
    oneOf('evidenceCompleteness', 'check_evidence_completeness', ['pending_email_proof', 'email_proved'], {
      req: true,
    }),
  ]),
  bool('emailProved', 'email_proved', { req: true }),
  idf('existingOrgId', 'existing_org_id'),
  text('applicantSecretHash', 'applicant_secret_hash', 64, { req: true, nonEmpty: true }),
  int('createdAt', 'created_at', { req: true }),
  int('decidedAt', 'decided_at'),
  text('decidedBy', 'decided_by_name', L.name),
  idf('decidedById', 'decided_by_id'),
  oneOf('decisionAttribution', 'decision_attribution', ATTRIBUTIONS),
  text('decisionReason', 'decision_reason', L.decisionReason),
  idf('resultOrgId', 'result_org_id'),
  idf('resultUserId', 'result_user_id'),
  oneOf('identityLink', 'identity_link', IDENTITY_LINKS),
] as const;
const DISPUTE_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  idf('claimId', 'claim_id', { req: true, nonEmpty: true }),
  oneOf('byKind', 'by_kind', ['org_user'], { req: true }),
  idf('byId', 'by_id', { req: true, nonEmpty: true }),
  text('byName', 'by_name', L.name),
  text('reason', 'reason', L.reason, { req: true, nonEmpty: true }),
  oneOf('status', 'status', ['open', 'resolved'], { req: true }),
  text('resolution', 'resolution', L.resolution),
  int('createdAt', 'created_at', { req: true }),
  int('resolvedAt', 'resolved_at'),
  text('resolvedBy', 'resolved_by_name', L.name),
  idf('resolvedById', 'resolved_by_id'),
  oneOf('resolutionAttribution', 'resolution_attribution', ATTRIBUTIONS),
] as const;
const REFERENCE_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  int('version', 'version', { req: true }),
  idf('supersedesId', 'supersedes_id'),
  idf('playerId', 'player_id', { req: true, nonEmpty: true }),
  text('playerName', 'player_name', L.name),
  idf('coachUserId', 'coach_user_id', { req: true, nonEmpty: true }),
  text('coachName', 'coach_name', L.name),
  idf('orgId', 'org_id', { req: true, nonEmpty: true }),
  text('orgName', 'org_name', L.name),
  text('roleAtTime', 'role_at_time', L.name),
  group('provenanceSnapshot', [
    idf('claimId', 'provenance_claim_id', { req: true, nonEmpty: true }),
    oneOf('claimType', 'provenance_claim_type', CLAIM_TYPES, { req: true }),
    oneOf('status', 'provenance_status', ['verified'], { req: true }),
    oneOf('method', 'provenance_method', METHODS),
    int('verifiedAt', 'provenance_verified_at'),
    int('snapshotAt', 'provenance_snapshot_at', { req: true }),
  ]),
  text('relationship', 'relationship', L.relationship, { req: true, nonEmpty: true }),
  text('capacity', 'capacity', L.capacity, { req: true }),
  int('fromYear', 'from_year'),
  int('toYear', 'to_year'),
  group('structured', [
    text('strengths', 'strengths', L.strengths, { req: true }),
    text('development', 'development', L.development, { req: true }),
    text('summary', 'summary', L.summary, { req: true, nonEmpty: true }),
  ]),
  oneOf('status', 'status', ['active', 'withdrawn', 'superseded'], { req: true }),
  int('withdrawnAt', 'withdrawn_at'),
  text('withdrawReason', 'withdraw_reason', L.withdrawReason),
  int('createdAt', 'created_at', { req: true }),
] as const;
const INVITE_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  idf('orgId', 'org_id', { req: true, nonEmpty: true }),
  idf('byUserId', 'by_user_id', { req: true, nonEmpty: true }),
  text('byName', 'by_name', L.name),
  text('name', 'invitee_name', L.inviteeName, { req: true, nonEmpty: true }),
  text('squad', 'squad', L.squad, { req: true }),
  oneOf('status', 'status', ['pending', 'accepted'], { req: true }),
  idf('playerId', 'player_id'),
  idf('targetPlayerId', 'target_player_id'),
  group(
    'guardianApproved',
    [
      idf('guardianId', 'guardian_approved_id', { req: true, nonEmpty: true }),
      int('at', 'guardian_approved_at', { req: true }),
    ],
    { nullable: true },
  ),
  int('createdAt', 'created_at', { req: true }),
  int('expiresAt', 'expires_at', { req: true }),
  int('acceptedAt', 'accepted_at'),
] as const;
const CONFLICT_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  idf('userId', 'user_id', { req: true, nonEmpty: true }),
  idf('orgId', 'org_id', { req: true, nonEmpty: true }),
  oneOf('kind', 'kind', CONFLICT_KINDS, { req: true }),
  text('subject', 'subject', L.subject, { req: true }),
  text('note', 'note', L.note, { req: true }),
  int('createdAt', 'created_at', { req: true }),
  int('withdrawnAt', 'withdrawn_at'),
] as const;
const DOMAIN_METHODS = ['official_domain_email', 'scoutbox_manual_review'] as const;
const DOMAIN_REQUEST_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }),
  idf('orgId', 'org_id', { req: true, nonEmpty: true }),
  text('domain', 'domain', L.domain, { req: true, nonEmpty: true }),
  idf('requestedBy', 'requested_by', { req: true, nonEmpty: true }),
  oneOf('status', 'status', ['email_challenge', 'requires_human_review', 'verified', 'rejected'], { req: true }),
  oneOf('method', 'method', DOMAIN_METHODS),
  int('createdAt', 'created_at', { req: true }),
  int('decidedAt', 'decided_at'),
  text('decidedBy', 'decided_by_name', L.name),
  idf('decidedById', 'decided_by_id'),
] as const;
const DOMAIN_SPEC = [
  idf('orgId', 'org_id', { req: true, nonEmpty: true }),
  text('domain', 'domain', L.domain, { req: true, nonEmpty: true }),
  oneOf('status', 'status', ['verified'], { req: true }),
  oneOf('method', 'method', DOMAIN_METHODS, { req: true }),
  int('verifiedAt', 'verified_at', { req: true }),
  idf('addedBy', 'added_by', { req: true, nonEmpty: true }),
] as const;

// ------------------------------------------------------------------ the records
type ClaimFields = RecordOf<typeof CLAIM_SPEC>;
type RootRequestFields = RecordOf<typeof ROOT_SPEC>;
type DomainFields = RecordOf<typeof DOMAIN_SPEC>;
/** Each collection's record as read back (before it is frozen). */
type Records = {
  verClaims: ClaimFields & { reviewReasons: ReviewCode[]; riskFlags: RiskFlag[]; evidenceIds: string[] };
  verEvents: RecordOf<typeof EVENT_SPEC>;
  verEvidence: RecordOf<typeof EVIDENCE_SPEC> & { claimIds: string[] };
  verTokens: RecordOf<typeof TOKEN_SPEC>;
  verAdmins: RecordOf<typeof ADMIN_SPEC>;
  verRootTransfers: RecordOf<typeof TRANSFER_SPEC>;
  verRootRequests: RootRequestFields & { reviewReasons: ReviewCode[]; riskFlags: RiskFlag[]; evidenceIds: string[] };
  verDisputes: RecordOf<typeof DISPUTE_SPEC>;
  verReferences: RecordOf<typeof REFERENCE_SPEC>;
  verPlayerInvites: RecordOf<typeof INVITE_SPEC>;
  verConflicts: RecordOf<typeof CONFLICT_SPEC>;
  verDomainRequests: RecordOf<typeof DOMAIN_REQUEST_SPEC> & { reviewReasons: ReviewCode[] };
  orgVerifiedDomains: DomainFields;
};
export type VerificationRecord<N extends VerificationCollection> = DeepReadonly<Records[N]>;
export type Claim = VerificationRecord<'verClaims'>;
export type VerificationEvent = VerificationRecord<'verEvents'>;
export type Evidence = VerificationRecord<'verEvidence'>;
export type VerificationToken = VerificationRecord<'verTokens'>;
export type VerificationAdmin = VerificationRecord<'verAdmins'>;
export type RootTransfer = VerificationRecord<'verRootTransfers'>;
export type RootRequest = VerificationRecord<'verRootRequests'>;
export type ClaimDispute = VerificationRecord<'verDisputes'>;
export type CoachReference = VerificationRecord<'verReferences'>;
export type PlayerInvite = VerificationRecord<'verPlayerInvites'>;
export type ConflictDeclaration = VerificationRecord<'verConflicts'>;
export type DomainRequest = VerificationRecord<'verDomainRequests'>;
/** An organisation's verified domain as `domains` returns it: the organisation is the one asked about. */
export type VerifiedDomain = DeepReadonly<Omit<DomainFields, 'orgId'>>;
export type ClaimSubjectKind = ClaimFields['subjectType'];
/** The whole domain as plain records (`VERIFICATION_RECORDS.read`). */
export type VerificationRecords = { [N in VerificationCollection]: Records[N][] };

type Codes = { reviewReasons?: readonly ReviewCode[]; riskFlags?: readonly RiskFlag[] };
export type ClaimInput = InputWith<ClaimFields, 'metadata'> & Codes & { evidenceIds?: readonly string[] };
export type VerificationEventInput = InputWith<Records['verEvents']>;
export type EvidenceInput = InputWith<RecordOf<typeof EVIDENCE_SPEC>, 'meta'> & { claimIds?: readonly string[] };
export type VerificationTokenInput = InputWith<Records['verTokens'], 'attemptsFailed'>;
export type VerificationAdminInput = InputWith<Records['verAdmins']>;
export type RootTransferInput = InputWith<Records['verRootTransfers']>;
export type RootRequestInput = InputWith<RootRequestFields> & Codes;
export type ClaimDisputeInput = InputWith<Records['verDisputes']>;
export type CoachReferenceInput = InputWith<Records['verReferences']>;
export type PlayerInviteInput = InputWith<Records['verPlayerInvites']>;
export type ConflictDeclarationInput = InputWith<Records['verConflicts']>;
export type DomainRequestInput = InputWith<RecordOf<typeof DOMAIN_REQUEST_SPEC>> & {
  reviewReasons?: readonly ReviewCode[];
};
export type VerifiedDomainInput = InputWith<Omit<DomainFields, 'orgId'>>;
type Inputs = {
  verClaims: ClaimInput;
  verEvents: VerificationEventInput;
  verEvidence: EvidenceInput;
  verTokens: VerificationTokenInput;
  verAdmins: VerificationAdminInput;
  verRootTransfers: RootTransferInput;
  verRootRequests: RootRequestInput;
  verDisputes: ClaimDisputeInput;
  verReferences: CoachReferenceInput;
  verPlayerInvites: PlayerInviteInput;
  verConflicts: ConflictDeclarationInput;
  verDomainRequests: DomainRequestInput;
  orgVerifiedDomains: VerifiedDomainInput;
};

// ------------------------------------------------------------------ DDL (generated from the specs, so the columns cannot drift from the typing)
const codeTableDdl = (
  name: string,
  owner: string,
  ownerTable: string,
  lists: Readonly<Record<string, readonly string[]>>,
) => `CREATE TABLE ${name} (
  ${owner}  TEXT NOT NULL REFERENCES ${ownerTable}(id) ON DELETE CASCADE,
  list      TEXT NOT NULL CHECK (list IN (${Object.keys(lists).map(quote).join(',')})),
  position  INTEGER NOT NULL,
  code      TEXT NOT NULL CHECK (${Object.entries(lists)
    .map(([l, vocab]) => `(list = ${quote(l)} AND code IN (${vocab.map(quote).join(',')}))`)
    .join(' OR ')}),
  PRIMARY KEY (${owner}, list, position),
  UNIQUE (${owner}, list, code)
) STRICT;`;
const CLAIM_LISTS = { review_reason: REVIEW_CODES, risk_flag: RISK_FLAGS };
const ROOT_LISTS = { review_reason: REVIEW_CODES, risk_flag: RISK_FLAGS };
const DOMAIN_REQUEST_LISTS = { review_reason: REVIEW_CODES };
const OPEN_STATES_SQL =
  "('unverified','collecting_evidence','pending','automated_checks_passed','requires_human_review','verified')";

export const VERIFICATION_DDL = [
  tableDdl('ver_root_requests', ROOT_SPEC, [
    'FOREIGN KEY (existing_org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    'FOREIGN KEY (result_org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    'FOREIGN KEY (result_user_id) REFERENCES org_users(id) ON DELETE RESTRICT',
  ]),
  'CREATE INDEX ver_root_requests_status ON ver_root_requests (status, country);',
  'CREATE INDEX ver_root_requests_existing_org ON ver_root_requests (existing_org_id, status);',
  'CREATE INDEX ver_root_requests_result_org ON ver_root_requests (result_org_id, status);',
  codeTableDdl('ver_root_request_codes', 'root_request_id', 'ver_root_requests', ROOT_LISTS),
  tableDdl('ver_claims', CLAIM_SPEC, [
    'FOREIGN KEY (organisation_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    'FOREIGN KEY (root_request_id) REFERENCES ver_root_requests(id) ON DELETE RESTRICT',
    'CHECK (verified_by_kind IS NOT NULL OR verified_by_id IS NULL)',
    'CHECK (revoked_by_kind IS NOT NULL OR revoked_by_id IS NULL)',
    'CHECK ((flagged_at IS NULL) = (flagged_reason IS NULL))',
    'CHECK (registry_provider IS NOT NULL OR (registry_state IS NULL AND registry_result IS NULL AND registry_checked_at IS NULL AND registry_reference IS NULL))',
    'CHECK (registry_provider IS NULL OR registry_checked_at IS NOT NULL)',
  ]),
  'CREATE INDEX ver_claims_subject ON ver_claims (subject_kind, subject_id);',
  "CREATE INDEX ver_claims_authority ON ver_claims (authority_id) WHERE authority_kind = 'org_admin';",
  'CREATE INDEX ver_claims_org_subject_status ON ver_claims (organisation_id, subject_kind, status);',
  'CREATE INDEX ver_claims_status ON ver_claims (status, claim_type);',
  "CREATE INDEX ver_claims_valid_until ON ver_claims (valid_until) WHERE status = 'verified';",
  "CREATE INDEX ver_claims_revoked_at ON ver_claims (revoked_at) WHERE status = 'revoked';",
  'CREATE UNIQUE INDEX ver_claims_subject_org_key ON ver_claims (id, subject_id, organisation_id);',
  'CREATE INDEX ver_claims_pair ON ver_claims (pair_id) WHERE pair_id IS NOT NULL;',
  `CREATE UNIQUE INDEX ver_claims_one_identity_per_user ON ver_claims (subject_id) WHERE subject_kind = 'user' AND claim_type = 'PERSON_IDENTITY' AND status IN ${OPEN_STATES_SQL};`,
  `CREATE UNIQUE INDEX ver_claims_one_current_affiliation ON ver_claims (subject_id, organisation_id, claim_type) WHERE subject_kind = 'user' AND current = 1 AND claim_type IN ('CLUB_AFFILIATION','CLUB_ROLE','AGENCY_AFFILIATION','AGENCY_ROLE','GRASSROOTS_AFFILIATION') AND status IN ${OPEN_STATES_SQL};`,
  codeTableDdl('ver_claim_codes', 'claim_id', 'ver_claims', CLAIM_LISTS),
  tableDdl('ver_evidence', EVIDENCE_SPEC, [
    'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    'FOREIGN KEY (root_request_id) REFERENCES ver_root_requests(id) ON DELETE RESTRICT',
    'CHECK (sha256 IS NULL OR length(sha256) = 64)',
    'CHECK (bytes IS NULL OR (bytes > 0 AND bytes <= 8388608))',
  ]),
  'CREATE INDEX ver_evidence_sha256 ON ver_evidence (sha256) WHERE sha256 IS NOT NULL;',
  'CREATE INDEX ver_evidence_root_request ON ver_evidence (root_request_id) WHERE root_request_id IS NOT NULL;',
  `CREATE TABLE ver_claim_evidence (
  claim_id     TEXT NOT NULL REFERENCES ver_claims(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  evidence_id  TEXT NOT NULL REFERENCES ver_evidence(id) ON DELETE RESTRICT,
  PRIMARY KEY (claim_id, position),
  UNIQUE (claim_id, evidence_id)
) STRICT;`,
  'CREATE INDEX ver_claim_evidence_evidence ON ver_claim_evidence (evidence_id);',
  tableDdl('ver_events', EVENT_SPEC, [
    'FOREIGN KEY (actor_org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    'FOREIGN KEY (claim_id) REFERENCES ver_claims(id) ON DELETE RESTRICT',
  ]),
  'CREATE INDEX ver_events_claim ON ver_events (claim_id) WHERE claim_id IS NOT NULL;',
  tableDdl('ver_tokens', TOKEN_SPEC, [
    'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    'CHECK (length(token_hash) = 64)',
    'CHECK (attempts_failed >= 0)',
  ]),
  'CREATE UNIQUE INDEX ver_tokens_hash ON ver_tokens (token_hash);',
  'CREATE INDEX ver_tokens_subject_purpose ON ver_tokens (subject_id, purpose);',
  tableDdl('ver_admins', ADMIN_SPEC, [
    'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    'FOREIGN KEY (user_id) REFERENCES org_users(id) ON DELETE RESTRICT',
    'FOREIGN KEY (revoked_by) REFERENCES org_users(id) ON DELETE RESTRICT',
  ]),
  'CREATE INDEX ver_admins_org_user ON ver_admins (org_id, user_id, status);',
  "CREATE UNIQUE INDEX ver_admins_one_active_grant ON ver_admins (org_id, user_id, level) WHERE status = 'active';",
  tableDdl('ver_root_transfers', TRANSFER_SPEC, [
    'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    'FOREIGN KEY (to_user_id) REFERENCES org_users(id) ON DELETE RESTRICT',
    'FOREIGN KEY (proposed_by) REFERENCES org_users(id) ON DELETE RESTRICT',
    'FOREIGN KEY (approved_by) REFERENCES org_users(id) ON DELETE RESTRICT',
  ]),
  "CREATE UNIQUE INDEX ver_root_transfers_one_pending ON ver_root_transfers (org_id) WHERE status = 'pending';",
  tableDdl('ver_disputes', DISPUTE_SPEC, [
    'FOREIGN KEY (claim_id) REFERENCES ver_claims(id) ON DELETE RESTRICT',
    'FOREIGN KEY (by_id) REFERENCES org_users(id) ON DELETE RESTRICT',
  ]),
  "CREATE UNIQUE INDEX ver_disputes_one_open_per_claim ON ver_disputes (claim_id) WHERE status = 'open';",
  'CREATE INDEX ver_disputes_status ON ver_disputes (status);',
  tableDdl('ver_references', REFERENCE_SPEC, [
    'FOREIGN KEY (supersedes_id, player_id, coach_user_id, org_id) REFERENCES ver_references(id, player_id, coach_user_id, org_id) ON DELETE RESTRICT',
    'FOREIGN KEY (coach_user_id) REFERENCES org_users(id) ON DELETE RESTRICT',
    'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    'FOREIGN KEY (provenance_claim_id, coach_user_id, org_id) REFERENCES ver_claims(id, subject_id, organisation_id) ON DELETE RESTRICT',
    'CHECK (version >= 1)',
    'CHECK ((supersedes_id IS NULL) = (version = 1))',
  ]),
  'CREATE UNIQUE INDEX ver_references_chain_key ON ver_references (id, player_id, coach_user_id, org_id);',
  'CREATE INDEX ver_references_player ON ver_references (player_id, status);',
  'CREATE INDEX ver_references_org ON ver_references (org_id);',
  tableDdl('ver_player_invites', INVITE_SPEC, [
    'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    'FOREIGN KEY (by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT',
    "CHECK ((status = 'accepted') = (player_id IS NOT NULL AND accepted_at IS NOT NULL))",
    'CHECK ((guardian_approved_id IS NULL) = (guardian_approved_at IS NULL))',
  ]),
  'CREATE INDEX ver_player_invites_org_created ON ver_player_invites (org_id, created_at);',
  'CREATE INDEX ver_player_invites_player ON ver_player_invites (player_id, status);',
  tableDdl('ver_conflicts', CONFLICT_SPEC, [
    'FOREIGN KEY (user_id) REFERENCES org_users(id) ON DELETE RESTRICT',
    'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
  ]),
  'CREATE INDEX ver_conflicts_org_user ON ver_conflicts (org_id, user_id);',
  'CREATE INDEX ver_conflicts_user ON ver_conflicts (user_id, withdrawn_at);',
  tableDdl('ver_domain_requests', DOMAIN_REQUEST_SPEC, [
    'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    'FOREIGN KEY (requested_by) REFERENCES org_users(id) ON DELETE RESTRICT',
  ]),
  'CREATE INDEX ver_domain_requests_org ON ver_domain_requests (org_id);',
  'CREATE INDEX ver_domain_requests_status ON ver_domain_requests (status);',
  codeTableDdl('ver_domain_request_codes', 'domain_request_id', 'ver_domain_requests', DOMAIN_REQUEST_LISTS),
  tableDdl('org_verified_domains', DOMAIN_SPEC, [
    'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT',
    'PRIMARY KEY (org_id, domain)',
  ]),
  'CREATE INDEX org_verified_domains_domain ON org_verified_domains (domain);',
  `CREATE TABLE ver_migrations (
  key            TEXT PRIMARY KEY CHECK (key IN ('m14')),
  ran_at         INTEGER NOT NULL,
  claims_created INTEGER NOT NULL CHECK (claims_created >= 0)
) STRICT;`,
].join('\n');
export const VERIFICATION_TABLES = Object.freeze([
  'ver_root_requests',
  'ver_root_request_codes',
  'ver_claims',
  'ver_claim_codes',
  'ver_evidence',
  'ver_claim_evidence',
  'ver_events',
  'ver_tokens',
  'ver_admins',
  'ver_root_transfers',
  'ver_disputes',
  'ver_references',
  'ver_player_invites',
  'ver_conflicts',
  'ver_domain_requests',
  'ver_domain_request_codes',
  'org_verified_domains',
  'ver_migrations',
] as const);

// ------------------------------------------------------------------ rows
type CodeListKey = 'reviewReasons' | 'riskFlags';
/** One entity: table, spec, the record's child lists, and the queries over it. */
type Entity = {
  table: string;
  spec: Spec;
  codes?: { table: string; owner: string; lists: Partial<Record<CodeListKey, string>> };
  evidenceLinks?: true;
  claimLinks?: true;
  rootEvidence?: true;
  key?: readonly string[];
};
const ENTITIES: Readonly<Record<VerificationCollection, Entity>> = {
  verClaims: {
    table: 'ver_claims',
    spec: CLAIM_SPEC,
    codes: {
      table: 'ver_claim_codes',
      owner: 'claim_id',
      lists: { reviewReasons: 'review_reason', riskFlags: 'risk_flag' },
    },
    evidenceLinks: true,
  },
  verEvents: { table: 'ver_events', spec: EVENT_SPEC },
  verEvidence: { table: 'ver_evidence', spec: EVIDENCE_SPEC, claimLinks: true },
  verTokens: { table: 'ver_tokens', spec: TOKEN_SPEC },
  verAdmins: { table: 'ver_admins', spec: ADMIN_SPEC },
  verRootTransfers: { table: 'ver_root_transfers', spec: TRANSFER_SPEC },
  verRootRequests: {
    table: 'ver_root_requests',
    spec: ROOT_SPEC,
    codes: {
      table: 'ver_root_request_codes',
      owner: 'root_request_id',
      lists: { reviewReasons: 'review_reason', riskFlags: 'risk_flag' },
    },
    rootEvidence: true,
  },
  verDisputes: { table: 'ver_disputes', spec: DISPUTE_SPEC },
  verReferences: { table: 'ver_references', spec: REFERENCE_SPEC },
  verPlayerInvites: { table: 'ver_player_invites', spec: INVITE_SPEC },
  verConflicts: { table: 'ver_conflicts', spec: CONFLICT_SPEC },
  verDomainRequests: {
    table: 'ver_domain_requests',
    spec: DOMAIN_REQUEST_SPEC,
    codes: { table: 'ver_domain_request_codes', owner: 'domain_request_id', lists: { reviewReasons: 'review_reason' } },
  },
  orgVerifiedDomains: { table: 'org_verified_domains', spec: DOMAIN_SPEC, key: ['org_id', 'domain'] },
};

type EntityStatements = {
  insert: StatementSync;
  /** Null for a table keyed by more than an id (org_verified_domains). */
  byId: StatementSync | null;
  all: StatementSync;
  codesOf?: StatementSync;
  codeIns?: StatementSync;
};
type Statements = Record<VerificationCollection, EntityStatements> & {
  linksOfClaim: StatementSync;
  linksOfEvidence: StatementSync;
  linkIns: StatementSync;
  linkNext: StatementSync;
  rootEvidence: StatementSync;
};
function statements(sqlite: DatabaseSync): Statements {
  const out = {} as Record<VerificationCollection, EntityStatements>;
  for (const name of VERIFICATION_COLLECTIONS) {
    const e = ENTITIES[name];
    out[name] = {
      insert: sqlite.prepare(insertSql(e.table, e.spec)),
      byId: e.key ? null : sqlite.prepare(`SELECT * FROM ${e.table} WHERE id = ?`),
      all: sqlite.prepare(`SELECT * FROM ${e.table} ORDER BY rowid`),
    };
    if (e.codes) {
      out[name].codesOf = sqlite.prepare(
        `SELECT * FROM ${e.codes.table} WHERE ${e.codes.owner} = ? ORDER BY list, position`,
      );
      out[name].codeIns = sqlite.prepare(
        `INSERT INTO ${e.codes.table} (${e.codes.owner}, list, position, code) VALUES (?, ?, ?, ?)`,
      );
    }
  }
  return {
    ...out,
    linksOfClaim: sqlite.prepare('SELECT * FROM ver_claim_evidence WHERE claim_id = ? ORDER BY position'),
    linksOfEvidence: sqlite.prepare('SELECT * FROM ver_claim_evidence WHERE evidence_id = ? ORDER BY rowid'),
    linkIns: sqlite.prepare('INSERT INTO ver_claim_evidence (claim_id, position, evidence_id) VALUES (?, ?, ?)'),
    linkNext: sqlite.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS n FROM ver_claim_evidence WHERE claim_id = ?'),
    rootEvidence: sqlite.prepare(
      'SELECT id, root_request_id FROM ver_evidence WHERE root_request_id = ? ORDER BY rowid',
    ),
  };
}
type ChildRows = { all(ownerId: string): Row[] };
type ChildReaders = {
  codes: ChildRows | null;
  links: ChildRows | null;
  claimLinks: ChildRows | null;
  rootEvidence: ChildRows | null;
};
/** The child rows of many records at once (one query per child table for a list). */
function childReaders(
  sqlite: DatabaseSync,
  st: Statements,
  name: VerificationCollection,
  idList: string[],
): ChildReaders {
  const e = ENTITIES[name];
  const many = idList.length > 1;
  return {
    codes: e.codes
      ? many
        ? childRowsOf(sqlite, e.codes.table, e.codes.owner, idList, { order: 'list, position' })
        : (st[name].codesOf as StatementSync)
      : null,
    links: e.evidenceLinks
      ? many
        ? childRowsOf(sqlite, 'ver_claim_evidence', 'claim_id', idList, { order: 'position' })
        : st.linksOfClaim
      : null,
    claimLinks: e.claimLinks
      ? many
        ? childRowsOf(sqlite, 'ver_claim_evidence', 'evidence_id', idList)
        : st.linksOfEvidence
      : null,
    rootEvidence: e.rootEvidence
      ? many
        ? childRowsOf(sqlite, 'ver_evidence', 'root_request_id', idList, { order: 'rowid' })
        : st.rootEvidence
      : null,
  };
}
// A child reader is present whenever the entity has that child list (childReaders above), hence the assertions.
function decodeRecord<N extends VerificationCollection>(name: N, row: Row, kids: ChildReaders): Records[N] {
  const e = ENTITIES[name];
  const rec = decode(e.spec, row) as Record<string, unknown>;
  const id = row.id as string;
  if (e.codes) {
    const rows = kids.codes!.all(id);
    for (const [key, list] of Object.entries(e.codes.lists))
      rec[key] = rows.filter((r) => r.list === list).map((r) => r.code);
  }
  if (e.evidenceLinks) rec.evidenceIds = kids.links!.all(id).map((r) => r.evidence_id);
  if (e.claimLinks) rec.claimIds = kids.claimLinks!.all(id).map((r) => r.claim_id);
  if (e.rootEvidence) rec.evidenceIds = kids.rootEvidence!.all(id).map((r) => r.id);
  return rec as Records[N];
}

// ------------------------------------------------------------------ the event detail line
const show = (v: unknown): string =>
  v === null || v === undefined
    ? '—'
    : Array.isArray(v)
      ? v.map(show).join(', ')
      : isPlainObject(v)
        ? Object.entries(v)
            .map(([k, x]) => `${k}=${show(x)}`)
            .join(' ')
        : String(v);
/** One line of text from an event's before/after payloads: `key: before → after` for each key either names. */
export function eventDetail(before: unknown, after: unknown): string | null {
  const b = isPlainObject(before) ? before : {};
  const a = isPlainObject(after) ? after : {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const parts = keys.map((k) =>
    k in b && k in a
      ? `${k}: ${show(b[k])} → ${show(a[k])}`
      : k in a
        ? `${k}: ${show(a[k])}`
        : `${k}: ${show(b[k])} (before)`,
  );
  const line = parts.join('; ');
  return line ? (line.length > L.detail ? `${line.slice(0, L.detail - 1)}…` : line) : null;
}

export const verificationLive = (sqlite: DatabaseSync): boolean => migrationApplied(sqlite, VERIFICATION_MIGRATION);
function readAll(sqlite: DatabaseSync): VerificationRecords {
  const st = statements(sqlite);
  const out: Partial<Record<VerificationCollection, unknown[]>> = {};
  for (const name of VERIFICATION_COLLECTIONS) {
    const rows = st[name].all.all();
    const kids = childReaders(sqlite, st, name, rows.map((r) => r.id as string).filter(Boolean));
    out[name] = rows.map((r) => decodeRecord(name, r, kids));
  }
  return out as VerificationRecords;
}

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const VERIFICATION_RECORDS = {
  names: VERIFICATION_COLLECTIONS,
  read(sqlite: DatabaseSync): VerificationRecords | null {
    return verificationLive(sqlite) ? readAll(sqlite) : null;
  },
};
const PLAYER_REFS_SQL =
  'SELECT player_id AS pid FROM ver_references UNION ALL SELECT player_id FROM ver_player_invites WHERE player_id IS NOT NULL UNION ALL SELECT target_player_id FROM ver_player_invites WHERE target_player_id IS NOT NULL';
const playerRefCount = (sqlite: DatabaseSync, cond: string): number =>
  (sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE ${cond}`).get() as { n: number }).n;
export const unresolvedPlayerReferences = (sqlite: DatabaseSync): { verification: number } | null =>
  verificationLive(sqlite)
    ? { verification: playerRefCount(sqlite, 'NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)') }
    : null;
export const retainedPlayerReferences = (sqlite: DatabaseSync): { verification: number } | null =>
  verificationLive(sqlite)
    ? {
        verification: playerRefCount(
          sqlite,
          'EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)',
        ),
      }
    : null;

// ------------------------------------------------------------------ the acts' inputs
/** The claim fields a status move may set besides the status: the transition's own effects and the decision's corrections. */
const MOVE_FIELDS = [
  'updatedAt',
  'verificationMethod',
  'verifiedAt',
  'verifiedBy',
  'suspendedAt',
  'suspendReason',
  'disputedAt',
  'revokedAt',
  'revokedBy',
  'revocationReason',
  'current',
  'expiredAt',
  'role',
  'validFrom',
  'validUntil',
  'authorityType',
  'authorityId',
] as const satisfies readonly (keyof ClaimFields)[];
const MOVE_METADATA = ['display', 'registry'] as const satisfies readonly (keyof ClaimFields['metadata'])[];
const PERIOD_FIELDS = ['validUntil', 'current'] as const satisfies readonly (keyof ClaimFields)[];
type ClaimMetadataInput = NonNullable<ClaimInput['metadata']>;
/** A claim's status move (`claims.move`): from the status the caller decided on, to `to`, with its effects. */
export type ClaimMove = {
  from: ClaimState;
  to: ClaimState;
  set?: Partial<Pick<ClaimInput, (typeof MOVE_FIELDS)[number]>>;
  metadata?: Partial<Pick<ClaimMetadataInput, (typeof MOVE_METADATA)[number]>>;
  /** Replaces the review reasons; `addReviewReasons` only adds the codes not yet held. */
  reviewReasons?: readonly ReviewCode[] | null;
  addReviewReasons?: readonly ReviewCode[];
  addRiskFlags?: readonly RiskFlag[];
};
export type ClaimPeriodCorrection = Partial<Pick<ClaimInput, (typeof PERIOD_FIELDS)[number]>>;
/** Who decided: a Trust & Safety reviewer as the route identified them. */
export type Reviewer = { id: string | null; name: string | null; attribution: Attribution };
type At = { at: number };
type AtBy = { at: number; by: string };
type Decision = { at: number; by: Reviewer; reason: string | null };
export type RootRequestApproval = Decision & {
  identityLink: IdentityLink;
  resultOrgId: string;
  resultUserId: string;
};

/** The statuses a claim may reach `to` from (CLAIM_TRANSITIONS). */
const sourcesOf = (to: ClaimState): ClaimState[] =>
  (Object.entries(CLAIM_TRANSITIONS) as [ClaimState, readonly ClaimState[]][])
    .filter(([, tos]) => tos.includes(to))
    .map(([from]) => from);
const METADATA_SPEC = (
  CLAIM_SPEC.find((f) => f.k === 'metadata') as Extract<(typeof CLAIM_SPEC)[number], { k: 'metadata' }>
).group;

// ------------------------------------------------------------------ the repository
/**
 * `createVerificationRepository({ sqlite, unit, now, log })`: one object per record kind (`claims`, `events`,
 * `evidence`, `tokens`, `admins`, `rootTransfers`, `rootRequests`, `disputes`, `references`, `playerInvites`,
 * `conflicts`, `domainRequests`, `domains`), each with its whole-record `create`, its named acts and its queries, plus
 * `reads` (the queries alone, for `verificationReads`). An act is `act(id, input)` and returns the stored record.
 */
export function createVerificationRepository(
  {
    sqlite,
    unit = null,
    now = Date.now,
    log = () => {},
  }: {
    sqlite: DatabaseSync;
    unit?: UnitParticipant | null;
    now?: () => number;
    log?: (message: string) => void;
  } = {} as { sqlite: DatabaseSync },
) {
  if (!sqlite) throw new TypeError('the verification repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const operation = operationOn(sqlite, unit);
  const kit = writeKit(sqlite, 'VERIFICATION');
  const { invalid, rowStep, listOf, readsBackAsWritten, columnsOf, q, sqlIn, guarded, nextPosition, actsOn } = kit;
  const newRecord: typeof kit.newRecord = kit.newRecord;
  const refuse = (what: 'DUPLICATE' | 'STATE_CONFLICT' | 'NOT_FOUND', message: string) =>
    refusal(`VERIFICATION_${what}`, message);
  // The columns judge the values a write binds (writes.ts), so they are bound as given.
  const bind = (cols: Record<string, unknown>) => cols as Record<string, SQLInputValue>;
  const decodeRows = <N extends VerificationCollection>(name: N, rows: Row[]): VerificationRecord<N>[] => {
    const kids = childReaders(
      sqlite,
      st,
      name,
      rows.map((r) => r.id as string),
    );
    return rows.map((r) => deepFreeze(decodeRecord(name, r, kids)));
  };
  const read = <N extends VerificationCollection>(name: N, id: unknown): VerificationRecord<N> | null => {
    if (typeof id !== 'string') return null;
    const row = st[name].byId!.get(id);
    return row ? decodeRows(name, [row])[0] : null;
  };
  const mustOf =
    <N extends VerificationCollection>(name: N) =>
    (id: string): VerificationRecord<N> => {
      const r = read(name, id);
      if (!r) throw refuse('NOT_FOUND', `${ENTITIES[name].table} ${id} is not a record of the repository`);
      return r;
    };
  /** The records of `name` matching `where`, in insertion order. */
  const all = <N extends VerificationCollection>(name: N, where: string, ...args: SQLInputValue[]) =>
    decodeRows(name, q(`SELECT * FROM ${ENTITIES[name].table} WHERE ${where} ORDER BY rowid`).all(...args));
  /** The first record of `name` matching `where`, or null. */
  const first = <N extends VerificationCollection>(
    name: N,
    where: string,
    ...args: SQLInputValue[]
  ): VerificationRecord<N> | null => {
    const row = q(`SELECT * FROM ${ENTITIES[name].table} WHERE ${where} ORDER BY rowid LIMIT 1`).get(...args);
    return row ? decodeRows(name, [row])[0] : null;
  };
  const exists = (sql: string, ...args: SQLInputValue[]): boolean => !!q(sql).get(...args);
  const countOf = (sql: string, ...args: SQLInputValue[]): number => (q(sql).get(...args) as { n: number }).n;
  const countWhere = (table: string, where: string, ...args: SQLInputValue[]) =>
    countOf(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...args);

  /** `create(record)`: a new record, whole. An existing id is refused, and the stored record must read back as written. */
  const create =
    <N extends VerificationCollection>(name: N) =>
    (raw: Inputs[N]): VerificationRecord<N> =>
      operation(() => {
        const e = ENTITIES[name];
        const r: unknown = raw;
        newRecord(e.table, (id) => !!st[name].byId!.get(id), r);
        const step = (part: string, fn: () => unknown) => rowStep(e.table, r.id, part, fn);
        step('row', () => st[name].insert.run(bind(columnsOf(e.table, r.id, e.spec, r, { defaults: true }))));
        if (e.codes)
          for (const [key, l] of Object.entries(e.codes.lists))
            listOf(e.table, r.id, key, r[key]).forEach((code, i) =>
              step(`${key}[${i}]`, () => st[name].codeIns!.run(r.id, l, i, code as SQLInputValue)),
            );
        if (e.evidenceLinks)
          listOf(e.table, r.id, 'evidenceIds', r.evidenceIds).forEach((ev, i) =>
            step(`evidenceIds[${i}]`, () => st.linkIns.run(r.id, i, ev as SQLInputValue)),
          );
        if (e.claimLinks)
          listOf(e.table, r.id, 'claimIds', r.claimIds).forEach((c, i) =>
            step(`claimIds[${i}]`, () =>
              st.linkIns.run(c as SQLInputValue, (st.linkNext.get(c as SQLInputValue) as { n: number }).n, r.id),
            ),
          );
        const stored = mustOf(name)(r.id);
        readsBackAsWritten(e.table, r.id, r, stored);
        return stored;
      });
  const kindActs = <N extends VerificationCollection>(name: N) => ({
    operation,
    label: ENTITIES[name].table,
    must: mustOf(name),
  });
  type CodeOwner = 'verClaims' | 'verRootRequests' | 'verDomainRequests';
  /** Code lists: `addCodes` appends the codes not yet held (a list only grows); `setCodes` replaces the list. */
  const addCodes = (name: CodeOwner, id: string, key: CodeListKey, codes: unknown) => {
    const e = ENTITIES[name];
    const c = e.codes!;
    const l = c.lists[key] as string;
    for (const code of listOf(e.table, id, key, codes)) {
      if (
        exists(`SELECT 1 FROM ${c.table} WHERE ${c.owner} = ? AND list = ? AND code = ?`, id, l, code as SQLInputValue)
      )
        continue;
      st[name].codeIns!.run(id, l, nextPosition(c.table, c.owner, id, { list: l }), code as SQLInputValue);
    }
  };
  const setCodes = (name: CodeOwner, id: string, key: CodeListKey, codes: unknown) => {
    const e = ENTITIES[name];
    const c = e.codes!;
    const l = c.lists[key] as string;
    q(`DELETE FROM ${c.table} WHERE ${c.owner} = ? AND list = ?`).run(id, l);
    listOf(e.table, id, key, codes).forEach((code, i) => st[name].codeIns!.run(id, l, i, code as SQLInputValue));
  };
  const C = ENTITIES.verClaims;
  const R = ENTITIES.verRootRequests;
  const OPEN = OPEN_STATES_SQL;
  const byCols = (prefix: string, by: { name: string | null; id: string | null } | null | undefined) => ({
    [`${prefix}_name`]: by?.name ?? null,
    [`${prefix}_id`]: by?.id ?? null,
  });
  const MOVE_FIELD_SET: ReadonlySet<string> = new Set(MOVE_FIELDS);
  const MOVE_METADATA_SET: ReadonlySet<string> = new Set(MOVE_METADATA);
  const PERIOD_FIELD_SET: ReadonlySet<string> = new Set(PERIOD_FIELDS);

  // ---- claims
  const claimWrites = {
    create: create('verClaims'),
    ...actsOn(kindActs('verClaims'), {
      /**
       * A status move along CLAIM_TRANSITIONS, from the status the caller decided on (`from`), guarded in SQL. `set` holds
       * the move's own effects and corrections (MOVE_FIELDS), `metadata` its display and registry result; the review
       * reasons are replaced (`reviewReasons`) or gain codes (`addReviewReasons`), the risk flags only gain codes.
       */
      move: (
        id: string,
        {
          from,
          to,
          set = {},
          metadata = {},
          reviewReasons = null,
          addReviewReasons = [],
          addRiskFlags = [],
        }: ClaimMove,
      ) => {
        const cols = {
          status: to,
          ...columnsOf(C.table, id, CLAIM_SPEC, set, { only: MOVE_FIELD_SET }),
          ...columnsOf(C.table, id, METADATA_SPEC, metadata, { only: MOVE_METADATA_SET }),
        };
        guarded(
          C.table,
          { id, status: from },
          sqlIn('status', sourcesOf(to)),
          cols,
          `ver_claims ${id} cannot move to ${to} from ${from}`,
        );
        if (reviewReasons) setCodes('verClaims', id, 'reviewReasons', reviewReasons);
        addCodes('verClaims', id, 'reviewReasons', addReviewReasons);
        addCodes('verClaims', id, 'riskFlags', addRiskFlags);
      },
      addRiskFlags: (id: string, { codes }: { codes: readonly RiskFlag[] }) =>
        addCodes('verClaims', id, 'riskFlags', codes),
      addReviewReasons: (id: string, { codes }: { codes: readonly ReviewCode[] }) =>
        addCodes('verClaims', id, 'reviewReasons', codes),
      /** The subject proved control of a work mailbox. */
      recordWorkEmail: (
        id: string,
        { workEmail, domainCoveredByOrg }: { workEmail: string; domainCoveredByOrg: boolean },
      ) =>
        guarded(
          C.table,
          { id },
          '',
          { work_email: workEmail, domain_control: 'passed', domain_covered_by_org: domainCoveredByOrg ? 1 : 0 },
          `ver_claims ${id}`,
        ),
      correctRole: (id: string, { role }: { role: string | null }) =>
        guarded(C.table, { id }, '', { role }, `ver_claims ${id}`),
      /** A departure closes a current verified period; a stated end is kept. */
      closePeriod: (id: string, { until, at }: { until: number | null; at: number }) => {
        if (
          q(
            "UPDATE ver_claims SET current = 0, valid_until = COALESCE(valid_until, @until), updated_at = @at WHERE id = @id AND status = 'verified' AND current = 1",
          ).run({ id, until, at }).changes !== 1
        )
          throw refuse('STATE_CONFLICT', `ver_claims ${id} is not a current verified claim`);
      },
      /** A reviewer's correction of the period or its currency (only the fields given). */
      correctPeriod: (id: string, fields: ClaimPeriodCorrection) =>
        guarded(
          C.table,
          { id },
          '',
          columnsOf(C.table, id, CLAIM_SPEC, fields, { only: PERIOD_FIELD_SET }),
          `ver_claims ${id}`,
        ),
      assign: (id: string, { assignedTo }: { assignedTo: string | null }) =>
        guarded(C.table, { id }, '', { assigned_to: assignedTo }, `ver_claims ${id}`),
      flagForReview: (id: string, { at, reason }: { at: number; reason: string }) =>
        guarded(
          C.table,
          { id },
          'flagged_at IS NULL',
          { flagged_at: at, flagged_reason: reason },
          `ver_claims ${id} is already flagged for review`,
        ),
      markExpiryWarned: (id: string, { at }: At) =>
        guarded(
          C.table,
          { id },
          'expiry_warned_at IS NULL',
          { expiry_warned_at: at },
          `ver_claims ${id} was already warned of its expiry`,
        ),
    }),
  };
  const claimReads = {
    byId: (id: unknown): Claim | null => read('verClaims', id),
    /** A subject's claims, oldest first (the public profile, the subject's own view). */
    forSubject: (kind: ClaimSubjectKind, subjectId: string): Claim[] =>
      all('verClaims', 'subject_kind = ? AND subject_id = ?', kind, subjectId),
    /** Every claim on subject id `id` whatever its kind (the Trust Score's identity source). */
    forSubjectId: (subjectId: string): Claim[] => all('verClaims', 'subject_id = ?', subjectId),
    /** The claims an organisation administrator approved (the authority cascade). */
    byAuthority: (authorityId: string): Claim[] =>
      all('verClaims', "authority_kind = 'org_admin' AND authority_id = ?", authorityId),
    /** An organisation's staff claims (subject a user), oldest first. */
    forOrgStaff: (orgId: string): Claim[] => all('verClaims', "organisation_id = ? AND subject_kind = 'user'", orgId),
    /** One person's claims at one organisation. */
    forOrgSubject: (orgId: string, subjectId: string): Claim[] =>
      all('verClaims', "organisation_id = ? AND subject_kind = 'user' AND subject_id = ?", orgId, subjectId),
    /** The claims of one affiliation/role pair. */
    byPair: (pairId: string): Claim[] => all('verClaims', 'pair_id = ?', pairId),
    /** Claims in any of `statuses`, optionally of one organisation and type: the T&S queue. */
    inStatuses: (
      statuses: readonly ClaimState[],
      { orgId = null, claimType = null }: { orgId?: string | null; claimType?: ClaimType | null } = {},
    ): Claim[] =>
      decodeRows(
        'verClaims',
        q(
          'SELECT * FROM ver_claims WHERE status IN (SELECT value FROM json_each(?)) AND (? IS NULL OR organisation_id = ?) AND (? IS NULL OR claim_type = ?) ORDER BY rowid',
        ).all(JSON.stringify(statuses), orgId, orgId, claimType, claimType),
      ),
    /** Verified claims whose validUntil falls in (from, until): expiring soon. */
    expiringBetween: (from: number, until: number): Claim[] =>
      all('verClaims', "status = 'verified' AND valid_until > ? AND valid_until < ?", from, until),
    /** Claims revoked since `since`. */
    revokedSince: (since: number): Claim[] => all('verClaims', "status = 'revoked' AND revoked_at > ?", since),
    /** The sweep: verified current claims past their exclusive expiry. */
    expiredBy: (at: number): Claim[] =>
      all('verClaims', "status = 'verified' AND current = 1 AND valid_until IS NOT NULL AND valid_until < ?", at),
    /** The sweep: verified claims expiring in (from, until) not yet warned. */
    warnDue: (from: number, until: number): Claim[] =>
      all(
        'verClaims',
        "status = 'verified' AND valid_until > ? AND valid_until < ? AND expiry_warned_at IS NULL",
        from,
        until,
      ),
    /** Has user `userId` an open or verified identity claim? */
    hasOpenIdentity: (userId: string): boolean =>
      exists(
        `SELECT 1 FROM ver_claims WHERE subject_kind = 'user' AND subject_id = ? AND claim_type = 'PERSON_IDENTITY' AND status IN ${OPEN}`,
        userId,
      ),
    count: (): number => countOf('SELECT COUNT(*) AS n FROM ver_claims'),
  };

  // ---- events
  /** Append one event (the log is only ever inserted into). */
  const eventWrites = { append: create('verEvents') };
  const eventReads = {
    forClaim: (claimId: string): VerificationEvent[] => all('verEvents', 'claim_id = ?', claimId),
  };

  // ---- evidence
  const evidenceWrites = { create: create('verEvidence') };
  const evidenceReads = {
    byId: (id: unknown): Evidence | null => read('verEvidence', id),
    /** A claim's evidence, in the claim's order. */
    forClaim: (claimId: string): Evidence[] =>
      decodeRows(
        'verEvidence',
        q(
          'SELECT e.* FROM ver_claim_evidence l JOIN ver_evidence e ON e.id = l.evidence_id WHERE l.claim_id = ? ORDER BY l.position',
        ).all(claimId),
      ),
    /** Evidence records `ids`, in that order (missing ids skipped). */
    byIds: (idList: readonly string[] | null | undefined): Evidence[] => {
      const rows = q('SELECT * FROM ver_evidence WHERE id IN (SELECT value FROM json_each(?))').all(
        JSON.stringify(idList ?? []),
      );
      const byKey = new Map(decodeRows('verEvidence', rows).map((e) => [e.id, e]));
      return (idList ?? []).map((i) => byKey.get(i)).filter((e): e is Evidence => !!e);
    },
    /** Does any evidence carry digest `sha` (optionally supplied by someone other than `exceptSupplier`)? */
    digestSeen: (sha: string, exceptSupplier: string | null = null): boolean =>
      exists(
        'SELECT 1 FROM ver_evidence WHERE sha256 = ? AND (? IS NULL OR supplied_by_id IS NOT ?) LIMIT 1',
        sha,
        exceptSupplier,
        exceptSupplier,
      ),
  };

  // ---- tokens
  const tokenWrites = {
    create: create('verTokens'),
    /** A wrong code counts against every open token of the subject for that purpose; the number of tokens counted. */
    recordFailedAttempts: (subjectId: string, purpose: TokenPurpose): number =>
      operation(
        () =>
          q(
            'UPDATE ver_tokens SET attempts_failed = attempts_failed + 1 WHERE subject_id = ? AND purpose = ? AND used_at IS NULL',
          ).run(subjectId, purpose).changes as number,
      ),
    /** A token is spent once. */
    ...actsOn(kindActs('verTokens'), {
      use: (id: string, { at }: At) =>
        guarded('ver_tokens', { id }, 'used_at IS NULL', { used_at: at }, `ver_tokens ${id} is already used`),
    }),
  };
  const tokenReads = {
    byId: (id: unknown): VerificationToken | null => read('verTokens', id),
    byHash: (hash: string): VerificationToken | null => first('verTokens', 'token_hash = ?', hash),
    /** Open (unused) tokens of `subjectId` for `purpose`. */
    openFor: (subjectId: string, purpose: TokenPurpose): VerificationToken[] =>
      all('verTokens', 'subject_id = ? AND purpose = ? AND used_at IS NULL', subjectId, purpose),
    /** The failed attempts recorded on `subjectId`'s tokens for `purpose`. */
    failedAttempts: (subjectId: string, purpose: TokenPurpose): number =>
      countOf(
        'SELECT COALESCE(SUM(attempts_failed), 0) AS n FROM ver_tokens WHERE subject_id = ? AND purpose = ?',
        subjectId,
        purpose,
      ),
  };

  // ---- verification administrators
  const adminWrites = {
    create: create('verAdmins'),
    ...actsOn(kindActs('verAdmins'), {
      revoke: (id: string, { at, by }: AtBy) =>
        guarded(
          'ver_admins',
          { id },
          "status = 'active'",
          { status: 'revoked', revoked_at: at, revoked_by: by },
          `ver_admins ${id} is not active`,
        ),
    }),
  };
  const adminReads = {
    byId: (id: unknown): VerificationAdmin | null => read('verAdmins', id),
    forOrg: (orgId: string): VerificationAdmin[] => all('verAdmins', 'org_id = ?', orgId),
    activeForOrg: (orgId: string): VerificationAdmin[] => all('verAdmins', "org_id = ? AND status = 'active'", orgId),
    activeFor: (orgId: string, userId: string): VerificationAdmin[] =>
      all('verAdmins', "org_id = ? AND user_id = ? AND status = 'active'", orgId, userId),
    activeRootCount: (orgId: string): number =>
      countWhere('ver_admins', "org_id = ? AND level = 'verification_root_admin' AND status = 'active'", orgId),
  };

  // ---- root-authority transfers
  const transferWrites = {
    create: create('verRootTransfers'),
    ...actsOn(kindActs('verRootTransfers'), {
      approve: (id: string, { at, by }: AtBy) =>
        guarded(
          'ver_root_transfers',
          { id },
          "status = 'pending'",
          { status: 'approved', approved_by: by, approved_at: at },
          `ver_root_transfers ${id} is not pending`,
        ),
    }),
  };
  const transferReads = {
    byId: (id: unknown): RootTransfer | null => read('verRootTransfers', id),
    forOrg: (orgId: string): RootTransfer[] => all('verRootTransfers', 'org_id = ?', orgId),
    hasPending: (orgId: string): boolean =>
      exists("SELECT 1 FROM ver_root_transfers WHERE org_id = ? AND status = 'pending'", orgId),
  };

  // ---- root organisation applications
  const decisionCols = (status: 'approved' | 'rejected', { at, by, reason }: Decision) => ({
    status,
    decided_at: at,
    decided_by_name: by.name,
    decided_by_id: by.id,
    decision_attribution: by.attribution,
    decision_reason: reason,
  });
  const rootRequestWrites = {
    create: create('verRootRequests'),
    ...actsOn(kindActs('verRootRequests'), {
      proveEmail: (id: string) =>
        guarded(
          R.table,
          { id },
          '',
          { email_proved: 1, check_evidence_completeness: 'email_proved' },
          `ver_root_requests ${id}`,
        ),
      addRiskFlags: (id: string, { codes }: { codes: readonly RiskFlag[] }) =>
        addCodes('verRootRequests', id, 'riskFlags', codes),
      /** The applicant submits: the application goes to Trust & Safety with its review reasons. */
      submitForReview: (id: string, { reviewReasons }: { reviewReasons: readonly ReviewCode[] }) => {
        guarded(
          R.table,
          { id },
          "status = 'collecting_evidence'",
          { status: 'requires_human_review' },
          `ver_root_requests ${id} is not collecting evidence`,
        );
        setCodes('verRootRequests', id, 'reviewReasons', reviewReasons);
      },
      approve: (id: string, { at, by, reason, identityLink, resultOrgId, resultUserId }: RootRequestApproval) =>
        guarded(
          R.table,
          { id },
          "status = 'requires_human_review'",
          {
            ...decisionCols('approved', { at, by, reason }),
            identity_link: identityLink,
            result_org_id: resultOrgId,
            result_user_id: resultUserId,
          },
          `ver_root_requests ${id} is not awaiting review`,
        ),
      reject: (id: string, { at, by, reason }: Decision) =>
        guarded(
          R.table,
          { id },
          "status IN ('requires_human_review','collecting_evidence')",
          decisionCols('rejected', { at, by, reason }),
          `ver_root_requests ${id} is already decided`,
        ),
    }),
  };
  const rootRequestReads = {
    byId: (id: unknown): RootRequest | null => read('verRootRequests', id),
    /** An open application for the same domain or organisation name (`orgName` lower-cased and trimmed). */
    openDuplicate: (domain: string, orgName: string): RootRequest | null =>
      first(
        'verRootRequests',
        "status IN ('requires_human_review','collecting_evidence') AND (domain = ? OR lower(trim(org_name)) = ?)",
        domain,
        orgName,
      ),
    /** Applications awaiting T&S (optionally of one country). */
    awaitingReview: (country: string | null = null): RootRequest[] =>
      decodeRows(
        'verRootRequests',
        q(
          "SELECT * FROM ver_root_requests WHERE status IN ('requires_human_review','collecting_evidence') AND (? IS NULL OR country = ?) ORDER BY rowid",
        ).all(country, country),
      ),
    /** Is an application for organisation `orgId` still open? */
    openForOrg: (orgId: string): boolean =>
      exists(
        "SELECT 1 FROM ver_root_requests WHERE (existing_org_id = ? OR result_org_id = ?) AND status IN ('requires_human_review','collecting_evidence') LIMIT 1",
        orgId,
        orgId,
      ),
  };

  // ---- claim disputes
  const disputeWrites = {
    create: create('verDisputes'),
    ...actsOn(kindActs('verDisputes'), {
      resolve: (id: string, { at, by, resolution }: { at: number; by: Reviewer; resolution: string }) =>
        guarded(
          'ver_disputes',
          { id },
          "status = 'open'",
          {
            status: 'resolved',
            resolution,
            resolved_at: at,
            ...byCols('resolved_by', by),
            resolution_attribution: by.attribution,
          },
          `ver_disputes ${id} is already resolved`,
        ),
    }),
  };
  const disputeReads = {
    byId: (id: unknown): ClaimDispute | null => read('verDisputes', id),
    all: (): ClaimDispute[] => all('verDisputes', '1 = 1'),
    open: (): ClaimDispute[] => all('verDisputes', "status = 'open'"),
    forClaim: (claimId: string): ClaimDispute[] => all('verDisputes', 'claim_id = ?', claimId),
    hasOpen: (claimId: string): boolean =>
      exists("SELECT 1 FROM ver_disputes WHERE claim_id = ? AND status = 'open'", claimId),
    /** Open disputes on organisation `orgId`'s staff claims. */
    openCountForOrg: (orgId: string): number =>
      countOf(
        "SELECT COUNT(*) AS n FROM ver_disputes d JOIN ver_claims c ON c.id = d.claim_id WHERE d.status = 'open' AND c.organisation_id = ? AND c.subject_kind = 'user'",
        orgId,
      ),
  };

  // ---- coach references
  const referenceWrites = {
    create: create('verReferences'),
    ...actsOn(kindActs('verReferences'), {
      withdraw: (id: string, { at, reason }: { at: number; reason: string | null }) =>
        guarded(
          'ver_references',
          { id },
          "status = 'active'",
          { status: 'withdrawn', withdrawn_at: at, withdraw_reason: reason },
          `ver_references ${id} is not active`,
        ),
      /** A correction replaces the reference with its next version (created after this). */
      supersede: (id: string) =>
        guarded(
          'ver_references',
          { id },
          "status = 'active'",
          { status: 'superseded' },
          `ver_references ${id} is not active`,
        ),
    }),
  };
  const referenceReads = {
    byId: (id: unknown): CoachReference | null => read('verReferences', id),
    forOrg: (orgId: string): CoachReference[] => all('verReferences', 'org_id = ?', orgId),
    /** A player's references, every status. */
    forPlayer: (playerId: string): CoachReference[] => all('verReferences', 'player_id = ?', playerId),
    /** A player's active references. */
    activeForPlayer: (playerId: string): CoachReference[] =>
      all('verReferences', "player_id = ? AND status = 'active'", playerId),
    hasActive: (playerId: string): boolean =>
      exists("SELECT 1 FROM ver_references WHERE player_id = ? AND status = 'active' LIMIT 1", playerId),
  };

  // ---- squad invitations
  const inviteWrites = {
    create: create('verPlayerInvites'),
    ...actsOn(kindActs('verPlayerInvites'), {
      /** Accepted once, by the player (or their guardian, who is recorded). */
      accept: (
        id: string,
        { playerId, at, guardianId = null }: { playerId: string; at: number; guardianId?: string | null },
      ) =>
        guarded(
          'ver_player_invites',
          { id },
          "status = 'pending' AND player_id IS NULL",
          {
            status: 'accepted',
            player_id: playerId,
            accepted_at: at,
            guardian_approved_id: guardianId,
            guardian_approved_at: guardianId ? at : null,
          },
          `ver_player_invites ${id} is not pending`,
        ),
    }),
  };
  const inviteReads = {
    byId: (id: unknown): PlayerInvite | null => read('verPlayerInvites', id),
    forOrg: (orgId: string): PlayerInvite[] => all('verPlayerInvites', 'org_id = ?', orgId),
    countSince: (orgId: string, since: number): number =>
      countWhere('ver_player_invites', 'org_id = ? AND created_at > ?', orgId, since),
    acceptedForPlayer: (playerId: string): PlayerInvite[] =>
      all('verPlayerInvites', "player_id = ? AND status = 'accepted'", playerId),
  };

  // ---- conflict-of-interest declarations
  const conflictWrites = {
    create: create('verConflicts'),
    ...actsOn(kindActs('verConflicts'), {
      withdraw: (id: string, { at }: At) =>
        guarded(
          'ver_conflicts',
          { id },
          'withdrawn_at IS NULL',
          { withdrawn_at: at },
          `ver_conflicts ${id} is already withdrawn`,
        ),
    }),
  };
  const conflictReads = {
    byId: (id: unknown): ConflictDeclaration | null => read('verConflicts', id),
    forOrg: (orgId: string): ConflictDeclaration[] => all('verConflicts', 'org_id = ?', orgId),
    forOrgUser: (orgId: string, userId: string): ConflictDeclaration[] =>
      all('verConflicts', 'org_id = ? AND user_id = ?', orgId, userId),
    activeForUser: (userId: string): ConflictDeclaration[] =>
      all('verConflicts', 'user_id = ? AND withdrawn_at IS NULL', userId),
  };

  // ---- domain requests
  const domainRequestWrites = {
    create: create('verDomainRequests'),
    ...actsOn(kindActs('verDomainRequests'), {
      /** The organisation proved the domain's mailbox. */
      confirmByEmail: (id: string, { at }: At) =>
        guarded(
          'ver_domain_requests',
          { id },
          "status = 'email_challenge'",
          { status: 'verified', method: 'official_domain_email', decided_at: at },
          `ver_domain_requests ${id} is not in its email challenge`,
        ),
      /** Trust & Safety's decision on an escalated request. */
      decide: (id: string, { approve, at, by }: { approve: boolean; at: number; by: Reviewer }) =>
        guarded(
          'ver_domain_requests',
          { id },
          "status = 'requires_human_review'",
          {
            status: approve ? 'verified' : 'rejected',
            ...(approve ? { method: 'scoutbox_manual_review' } : {}),
            decided_at: at,
            ...byCols('decided_by', by),
          },
          `ver_domain_requests ${id} is not awaiting review`,
        ),
    }),
  };
  const domainRequestReads = {
    byId: (id: unknown): DomainRequest | null => read('verDomainRequests', id),
    forOrg: (orgId: string): DomainRequest[] => all('verDomainRequests', 'org_id = ?', orgId),
    awaitingReview: (): DomainRequest[] => all('verDomainRequests', "status = 'requires_human_review'"),
  };

  // ---- an organisation's verified domains
  const domainRow = (orgId: string, domain: unknown) =>
    q('SELECT * FROM org_verified_domains WHERE org_id = ? AND domain = ?').get(orgId, domain as SQLInputValue);
  const domainView = (row: Row): VerifiedDomain => {
    const { orgId: _o, ...d } = decode(DOMAIN_SPEC, row);
    return deepFreeze(d);
  };
  const domainReads = {
    /** An organisation's verified domains, in the order they were added. */
    forOrg: (orgId: string): VerifiedDomain[] =>
      q('SELECT * FROM org_verified_domains WHERE org_id = ? ORDER BY rowid').all(orgId).map(domainView),
    has: (orgId: string, domain: string): boolean => !!domainRow(orgId, domain),
    /** The organisation other than `exceptOrgId` that verified `domain`, or null. */
    verifiedElsewhere: (domain: string, exceptOrgId: string | null = null): string | null =>
      (
        q(
          'SELECT org_id FROM org_verified_domains WHERE domain = ? AND (? IS NULL OR org_id <> ?) ORDER BY rowid LIMIT 1',
        ).get(domain, exceptOrgId, exceptOrgId) as { org_id: string } | undefined
      )?.org_id ?? null,
  };
  const domainWrites = {
    add: (orgId: string, entry: VerifiedDomainInput): VerifiedDomain =>
      operation(() => {
        const raw: unknown = entry;
        const label = `${orgId}/${(raw as { domain?: unknown } | null | undefined)?.domain}`;
        if (!isPlainObject(raw))
          throw invalid(`org_verified_domains ${label}: an entry must be an object (got ${describe(raw)})`);
        if (domainRow(orgId, raw.domain)) throw refuse('DUPLICATE', `org_verified_domains ${label} already exists`);
        rowStep('org_verified_domains', label, 'row', () =>
          st.orgVerifiedDomains.insert.run(
            bind(columnsOf('org_verified_domains', label, DOMAIN_SPEC, { ...raw, orgId })),
          ),
        );
        const stored = domainView(domainRow(orgId, raw.domain) as Row);
        readsBackAsWritten('org_verified_domains', label, raw, stored);
        return stored;
      }),
    remove: (orgId: string, domain: string): boolean =>
      operation(
        () => q('DELETE FROM org_verified_domains WHERE org_id = ? AND domain = ?').run(orgId, domain).changes > 0,
      ),
  };
  const bootstrapMarker = {
    /** Has the one-time bootstrap (claims for organisations already verified) run on this database? */
    ran: (): boolean => exists("SELECT 1 FROM ver_migrations WHERE key = 'm14'"),
    recordBootstrap: (at: number, claimsCreated: number): void =>
      operation(() => {
        q("INSERT INTO ver_migrations (key, ran_at, claims_created) VALUES ('m14', ?, ?)").run(at, claimsCreated);
      }),
  };
  const counters = Object.fromEntries(
    VERIFICATION_COLLECTIONS.map((n) => [n, sqlite.prepare(`SELECT COUNT(*) AS n FROM ${ENTITIES[n].table}`)]),
  ) as Record<VerificationCollection, StatementSync>;
  const counts = () =>
    Object.fromEntries(VERIFICATION_COLLECTIONS.map((n) => [n, (counters[n].get() as { n: number }).n])) as Record<
      VerificationCollection,
      number
    >;
  /** The queries alone, for modules and projectors that must not write (`verificationReads`). */
  const reads = Object.freeze({
    claims: Object.freeze(claimReads),
    events: Object.freeze(eventReads),
    evidence: Object.freeze(evidenceReads),
    tokens: Object.freeze(tokenReads),
    admins: Object.freeze(adminReads),
    rootTransfers: Object.freeze(transferReads),
    rootRequests: Object.freeze(rootRequestReads),
    disputes: Object.freeze(disputeReads),
    references: Object.freeze(referenceReads),
    playerInvites: Object.freeze(inviteReads),
    conflicts: Object.freeze(conflictReads),
    domainRequests: Object.freeze(domainRequestReads),
    domains: Object.freeze(domainReads),
  });
  return {
    claims: { ...claimWrites, ...claimReads },
    events: { ...eventWrites, ...eventReads },
    evidence: { ...evidenceWrites, ...evidenceReads },
    tokens: { ...tokenWrites, ...tokenReads },
    admins: { ...adminWrites, ...adminReads },
    rootTransfers: { ...transferWrites, ...transferReads },
    rootRequests: { ...rootRequestWrites, ...rootRequestReads },
    disputes: { ...disputeWrites, ...disputeReads },
    references: { ...referenceWrites, ...referenceReads },
    playerInvites: { ...inviteWrites, ...inviteReads },
    conflicts: { ...conflictWrites, ...conflictReads },
    domainRequests: { ...domainRequestWrites, ...domainRequestReads },
    domains: { ...domainReads, ...domainWrites },
    bootstrap: bootstrapMarker,
    reads,
    /** Run `fn` as one transaction of this repository (joined into an open unit of work). */
    atomically: <T>(fn: () => T): T => operation(fn),
    attach(): { counts: Record<VerificationCollection, number> } {
      if (!verificationLive(sqlite))
        throw new Error(
          `the verification repository needs ${VERIFICATION_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: counts() };
    },
    counts,
    exportAll(): VerificationRecords | null {
      return VERIFICATION_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}
export type VerificationRepository = ReturnType<typeof createVerificationRepository>;
export type VerificationReads = VerificationRepository['reads'];
