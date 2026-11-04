/**
 * S10a — verification claims as typed tables (migration `0023_verification`; docs/architecture/migration.md §4.3
 * "The pattern", §4.5 S10; sql/05_verification_passport.sql).
 *
 * Records: staff and organisation claims (with their review-reason and risk-flag codes and their evidence links), the
 * append-only verification event log, evidence records (verification documents, email and registry proofs, and the
 * signing and transaction documents other domains file through the same vault), one-time tokens (hashes only),
 * verification administrators, root-authority transfers, root organisation applications (with their codes), claim
 * disputes, coach references, squad invitations by code, conflict-of-interest declarations, domain requests (with their
 * codes) and an organisation's verified domains (the former `orgs.verification.domains` facet). Every field is a typed
 * column with its vocabulary and length CHECKs; there are no side columns and no JSON columns: a claim's `metadata` and
 * an evidence record's `meta` are fixed sets of optional typed columns, and an event's before/after payload is one line
 * of text (`detail`). A record the columns cannot hold is refused with its id.
 *
 * WRITES are explicit: `create(record)` and `update(id, (draft) => …)` type the whole record and write its rows at once,
 * joined into the open unit of work, the caller's open transaction, or a transaction of their own. An unknown field is
 * refused, and so is an update of a record from inside its own update. Events are append-only (`events.append`).
 * Evidence created with `claimIds` is linked to those claims at once (the claim's `evidenceIds` grow by one row each);
 * a claim's `evidenceIds` are rewritten by its own update. A root application's evidence is the evidence whose
 * `meta.rootRequest` names it.
 *
 * READS are SQL: no mirror, and every db.ver* name throws, naming this repository. Queries decode fresh, deep-frozen
 * records in insertion (rowid) order unless they say otherwise. Modules receive them as `verificationReads`.
 *
 * References. Player ids (references, invitations, tokens) carry no key: tolerant, as recruitment and scouting. Org ids
 * → orgs and staff ids → org_users are immediate RESTRICT keys; claim, evidence, root-request and reference keys inside
 * the domain are immediate RESTRICT keys. Polymorphic ids (a claim's subject and authority, an event's subject, a
 * token's subject and ref, an invitation's inviter of record 'trust_safety') carry none.
 */
import { isPlainObject, ids, describe } from './recruitment.mjs';
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { deepFreeze } from './scoutingEvidence.mjs';

export const VERIFICATION_MIGRATION = '0023_verification';
export const VERIFICATION_COLLECTIONS = Object.freeze(['verClaims', 'verEvents', 'verEvidence', 'verTokens', 'verAdmins', 'verRootTransfers', 'verRootRequests', 'verDisputes', 'verReferences', 'verPlayerInvites', 'verConflicts', 'verDomainRequests', 'orgVerifiedDomains']);
/** Blob-era names that are gone without a collection of their own (the M14 boot marker is a ver_migrations row). */
export const VERIFICATION_RETIRED = Object.freeze(['verMigrated']);

// ------------------------------------------------------------------ vocabularies (one definition; the domain module imports them)
export const CLAIM_TYPES = Object.freeze(['PERSON_IDENTITY', 'ORGANISATION_IDENTITY', 'ORGANISATION_DOMAIN', 'ORGANISATION_ADMIN', 'CLUB_AFFILIATION', 'CLUB_ROLE', 'LICENCE', 'AGENCY_AFFILIATION', 'AGENCY_ROLE', 'GRASSROOTS_AFFILIATION', 'FEDERATION_AFFILIATION']);
export const CLAIM_STATES = Object.freeze(['unverified', 'collecting_evidence', 'pending', 'automated_checks_passed', 'requires_human_review', 'verified', 'rejected', 'expired', 'suspended', 'revoked', 'disputed', 'superseded']);
export const METHODS = Object.freeze(['official_domain_email', 'organisation_admin_confirmation', 'authoritative_registry', 'federation_confirmation', 'existing_verified_org_admin', 'scoutbox_manual_review', 'document_submitted', 'reference_confirmation', 'migration']);
export const REVIEW_REASONS = Object.freeze(['ROOT_ORGANISATION_BOOTSTRAP', 'NO_AUTHORITATIVE_SOURCE', 'CONFLICTING_EVIDENCE', 'IDENTITY_MISMATCH', 'DOMAIN_OWNERSHIP_AMBIGUOUS', 'DUPLICATE_ORGANISATION', 'HIGH_RISK_ADMIN_CHANGE', 'DOCUMENT_AUTHENTICITY_UNCONFIRMED', 'REGISTRY_AMBIGUOUS_MATCH', 'DISPUTED_CLAIM', 'SUSPECTED_FRAUD_SIGNALS', 'MANUAL_EXCEPTION_REQUESTED']);
/** The codes a review-reason list can hold: the engine's reasons plus the registry's unreadable-record reason. */
export const REVIEW_CODES = Object.freeze([...REVIEW_REASONS, 'REGISTRY_RECORD_UNREADABLE']);
export const RISK_FLAGS = Object.freeze(['DISPOSABLE_EMAIL', 'FREE_EMAIL_PROVIDER', 'ORG_DOMAIN_MISMATCH', 'REPEATED_EMAIL_CHALLENGE_FAILURES', 'COMPETING_ORGANISATION_CLAIMS', 'CREDENTIAL_REUSED_ACROSS_USERS', 'DUPLICATE_EVIDENCE_HASH', 'RECENT_REVOCATION_REAPPLY', 'ORGANISATION_SUSPENDED', 'CONFLICTING_ACTIVE_ROLES', 'UNUSUAL_MASS_ACTIVITY', 'SELF_VERIFICATION_ATTEMPT']);
export const VER_LEVELS = Object.freeze(['verification_viewer', 'verification_reviewer', 'verification_admin', 'verification_root_admin']);
export const EVIDENCE_TYPES = Object.freeze(['official_email', 'document', 'registry_result', 'organisation_confirmation', 'federation_confirmation', 'reference', 'existing_claim']);
export const EVIDENCE_VISIBILITY = Object.freeze(['trust_and_safety', 'organisation_internal', 'subject_only']);
export const EVIDENCE_MIMES = Object.freeze(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
export const ROOT_ORG_TYPES = Object.freeze(['professional club', 'academy', 'grassroots club', 'federation/association', 'agency', 'other approved football organisation']);
export const CONFLICT_KINDS = Object.freeze(['family_relationship', 'agent_relationship', 'financial_interest', 'coaching_relationship', 'other']);
export const TOKEN_PURPOSES = Object.freeze(['work_email', 'domain_email', 'player_invite', 'root_email']);
export const ATTRIBUTIONS = Object.freeze(['authenticated_reviewer', 'declared_reviewer', 'shared_admin_key']);
export const IDENTITY_LINKS = Object.freeze(['trust_safety_selection', 'provisioned_new_user', 'verified_work_email']);
export const EVENT_TYPES = Object.freeze([
  'claim.created', ...CLAIM_STATES.filter((s) => s !== 'unverified').map((s) => `claim.${s}`), 'claim.unverified', 'claim.reinstated', 'claim.corrected',
  'review.requested', 'review.assigned', 'review.approved', 'review.rejected', 'automated_check.passed', 'automated_check.failed',
  'evidence.added', 'evidence.accessed', 'email.challenge_sent', 'email.challenge_passed', 'security.self_verification_blocked',
  'organisation.domain_added', 'organisation.domain_verified', 'organisation.domain_removed', 'admin.invited', 'admin.accepted', 'admin.revoked',
]);
/** Text limits: the routes check or shorten to these; the columns refuse anything longer. */
export const VERIFICATION_LIMITS = Object.freeze({
  id: 80, name: 200, role: 60, reason: 600, note: 400, email: 254, domain: 253, licenceType: 80, issuer: 80, identifier: 60, holderName: 80,
  display: 300, provider: 60, website: 200, orgName: 120, country: 40, federation: 80, applicantName: 80, applicantRole: 60, officialContact: 200,
  decisionReason: 400, appointedReason: 300, flaggedReason: 300, assignedTo: 60, migratedFrom: 200, documentReviewed: 200, via: 60,
  filename: 120, source: 60, label: 120, relationship: 80, capacity: 120, strengths: 500, development: 500, summary: 800, withdrawReason: 300,
  inviteeName: 80, squad: 60, subject: 120, requestId: 120, detail: 1000, resolution: 320, registryDate: 40,
});
const L = VERIFICATION_LIMITS;

// ------------------------------------------------------------------ field specs (one description drives typing, rows and decoding)
const text = (k, c, max, o = {}) => ({ k, c, t: 'text', max, ...o });
const int = (k, c, o = {}) => ({ k, c, t: 'int', ...o });
const bool = (k, c, o = {}) => ({ k, c, t: 'bool', ...o });
const oneOf = (k, c, vals, o = {}) => ({ k, c, t: 'enum', vals, ...o });
const idf = (k, c, o = {}) => text(k, c, L.id, o);
/** A nested object stored as columns: `nullable` groups are null when their first column is; `sparse` objects keep only non-null keys. */
const group = (k, fields, o = {}) => ({ k, group: fields, ...o });

const CLAIM_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }), oneOf('subjectType', 'subject_kind', ['user', 'org'], { req: true }), idf('subjectId', 'subject_id', { req: true, nonEmpty: true }),
  oneOf('claimType', 'claim_type', CLAIM_TYPES, { req: true }), idf('organisationId', 'organisation_id'), text('role', 'role', L.role),
  oneOf('status', 'status', CLAIM_STATES, { req: true }), int('validFrom', 'valid_from'), int('validUntil', 'valid_until'), bool('current', 'current', { req: true }),
  oneOf('verificationMethod', 'verification_method', METHODS), oneOf('authorityType', 'authority_kind', ['org_admin', 'trust_safety']), idf('authorityId', 'authority_id'),
  int('createdAt', 'created_at', { req: true }), int('updatedAt', 'updated_at', { req: true }), int('verifiedAt', 'verified_at'),
  group('verifiedBy', [oneOf('kind', 'verified_by_kind', ['system', 'org_user', 'org_admin', 'trust_safety'], { req: true }), idf('id', 'verified_by_id')], { nullable: true }),
  int('revokedAt', 'revoked_at'),
  group('revokedBy', [oneOf('kind', 'revoked_by_kind', ['system', 'org_user', 'org_admin', 'trust_safety'], { req: true }), idf('id', 'revoked_by_id')], { nullable: true }),
  text('revocationReason', 'revocation_reason', L.reason), int('suspendedAt', 'suspended_at'), text('suspendReason', 'suspend_reason', L.reason),
  int('disputedAt', 'disputed_at'), int('expiredAt', 'expired_at'),
  group('metadata', [
    text('declaredName', 'declared_name', L.name), idf('pairId', 'pair_id'), int('requestedStart', 'requested_start'),
    text('workEmail', 'work_email', L.email), oneOf('domainControl', 'domain_control', ['passed']), bool('domainCoveredByOrg', 'domain_covered_by_org'),
    text('domain', 'domain', L.domain), text('licenceType', 'licence_type', L.licenceType), text('issuer', 'issuer', L.issuer),
    text('identifier', 'identifier', L.identifier), text('holderName', 'holder_name', L.holderName), text('display', 'display', L.display),
    group('registry', [text('provider', 'registry_provider', L.provider, { req: true }), oneOf('state', 'registry_state', ['not_configured', 'temporarily_unavailable', 'unsupported']), oneOf('result', 'registry_result', ['match', 'no_match', 'unreadable_record']), int('checkedAt', 'registry_checked_at', { req: true }), text('reference', 'registry_reference', L.identifier)], { nullable: true, sparse: true }),
    idf('rootRequest', 'root_request_id'), oneOf('orgType', 'org_type', ROOT_ORG_TYPES), text('website', 'website', L.website),
    oneOf('level', 'admin_level', VER_LEVELS), oneOf('identityLink', 'identity_link', IDENTITY_LINKS), text('appointedReason', 'appointed_reason', L.appointedReason),
    text('via', 'via', L.via), group('flaggedForReview', [int('at', 'flagged_at', { req: true }), text('reason', 'flagged_reason', L.flaggedReason, { req: true })], { nullable: true }),
    text('migratedFrom', 'migrated_from', L.migratedFrom), text('note', 'note', L.note), idf('representationId', 'representation_id'),
    text('documentReviewed', 'document_reviewed', L.documentReviewed), text('assignedTo', 'assigned_to', L.assignedTo), int('expiryWarned', 'expiry_warned_at'),
  ], { sparse: true }),
];
const EVENT_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }), int('ts', 'occurred_at', { req: true }), oneOf('type', 'type', EVENT_TYPES, { req: true }),
  oneOf('actorKind', 'actor_kind', ['org_user', 'system', 'trust_safety'], { req: true }), idf('actorId', 'actor_id'), text('actorName', 'actor_name', L.name),
  idf('actorOrgId', 'actor_org_id'), text('requestId', 'request_id', L.requestId), oneOf('attribution', 'attribution', ATTRIBUTIONS),
  idf('claimId', 'claim_id'), idf('subjectId', 'subject_id'), idf('orgId', 'org_id'), text('detail', 'detail', L.detail), text('reason', 'reason', L.reason),
];
const EVIDENCE_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }), oneOf('type', 'type', EVIDENCE_TYPES, { req: true }), text('source', 'source', L.source, { req: true, nonEmpty: true }),
  oneOf('suppliedByKind', 'supplied_by_kind', ['org_user', 'applicant', 'system'], { req: true }), idf('suppliedById', 'supplied_by_id'), idf('orgId', 'org_id'),
  int('receivedAt', 'received_at', { req: true }), idf('mediaId', 'media_id'), text('sha256', 'sha256', 64), oneOf('mime', 'mime', EVIDENCE_MIMES),
  int('bytes', 'bytes'), text('filename', 'filename', L.filename),
  group('meta', [
    text('note', 'note', L.note), text('domain', 'domain', L.domain), bool('domainCoveredByOrg', 'domain_covered_by_org'), text('addressHash', 'address_hash', 64),
    idf('rootRequest', 'root_request_id'), text('identifier', 'identifier', L.identifier), text('licenceType', 'licence_type', L.licenceType),
    text('validUntil', 'registry_valid_until', L.registryDate), idf('signingPackageId', 'signing_package_id'), oneOf('signingDocumentKind', 'signing_document_kind', ['signing', 'executed']),
    text('label', 'label', L.label),
  ], { sparse: true }),
  group('checks', [oneOf('malwareScan', 'check_malware_scan', ['not_configured'], { req: true }), oneOf('contentSignature', 'check_content_signature', ['matched_claimed_type'])], { sparse: true }),
  oneOf('retention', 'retention', ['until_claim_resolution', 'until_signing_resolution'], { req: true }),
  oneOf('visibility', 'visibility', EVIDENCE_VISIBILITY, { req: true }), int('expiresAt', 'expires_at'),
];
const TOKEN_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }), text('hash', 'token_hash', 64, { req: true, nonEmpty: true }), oneOf('purpose', 'purpose', TOKEN_PURPOSES, { req: true }),
  text('email', 'email', L.email), oneOf('subjectKind', 'subject_kind', ['org_user', 'player']), idf('subjectId', 'subject_id'), idf('orgId', 'org_id'), idf('refId', 'ref_id'),
  int('createdAt', 'created_at', { req: true }), int('expiresAt', 'expires_at', { req: true }), int('usedAt', 'used_at'), int('attemptsFailed', 'attempts_failed', { req: true, def: 0 }),
];
const ADMIN_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }), idf('orgId', 'org_id', { req: true, nonEmpty: true }), idf('userId', 'user_id', { req: true, nonEmpty: true }),
  oneOf('level', 'level', VER_LEVELS, { req: true }), oneOf('status', 'status', ['active', 'revoked'], { req: true }), idf('invitedBy', 'invited_by', { req: true, nonEmpty: true }),
  int('createdAt', 'created_at', { req: true }), int('acceptedAt', 'accepted_at'), int('revokedAt', 'revoked_at'), idf('revokedBy', 'revoked_by'),
];
const TRANSFER_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }), idf('orgId', 'org_id', { req: true, nonEmpty: true }), idf('toUserId', 'to_user_id', { req: true, nonEmpty: true }),
  idf('proposedBy', 'proposed_by', { req: true, nonEmpty: true }), oneOf('status', 'status', ['pending', 'approved'], { req: true }), int('createdAt', 'created_at', { req: true }),
  idf('approvedBy', 'approved_by'), int('approvedAt', 'approved_at'),
];
const PF = ['passed', 'flagged'];
const ROOT_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }), oneOf('status', 'status', ['collecting_evidence', 'requires_human_review', 'approved', 'rejected'], { req: true }),
  text('orgName', 'org_name', L.orgName, { req: true, nonEmpty: true }), oneOf('orgType', 'org_type', ROOT_ORG_TYPES, { req: true }), text('country', 'country', L.country, { req: true }),
  text('federation', 'federation', L.federation), text('website', 'website', L.website, { req: true }), text('domain', 'domain', L.domain, { req: true }),
  text('applicantName', 'applicant_name', L.applicantName, { req: true, nonEmpty: true }), text('applicantRole', 'applicant_role', L.applicantRole, { req: true }),
  text('workEmail', 'work_email', L.email, { req: true, nonEmpty: true }), text('officialContact', 'official_contact', L.officialContact),
  group('declarations', [bool('authorised', 'declared_authorised', { req: true })], { nullable: true }),
  group('checks', [
    oneOf('emailSyntax', 'check_email_syntax', ['passed'], { req: true }), oneOf('emailDomainAlignment', 'check_email_domain_alignment', ['passed', 'mismatch'], { req: true }),
    oneOf('freeEmailProvider', 'check_free_email_provider', PF, { req: true }), oneOf('disposableEmail', 'check_disposable_email', PF, { req: true }),
    text('domainNormalized', 'check_domain_normalized', L.domain + 10, { req: true }), oneOf('dnsOwnership', 'check_dns_ownership', ['not_configured'], { req: true }),
    oneOf('duplicateOrganisation', 'check_duplicate_organisation', PF, { req: true }), oneOf('duplicateRequest', 'check_duplicate_request', PF, { req: true }),
    oneOf('domainAlreadyVerifiedElsewhere', 'check_domain_already_verified_elsewhere', PF, { req: true }),
    oneOf('evidenceCompleteness', 'check_evidence_completeness', ['pending_email_proof', 'email_proved'], { req: true }),
  ]),
  bool('emailProved', 'email_proved', { req: true }), idf('existingOrgId', 'existing_org_id'), text('applicantSecretHash', 'applicant_secret_hash', 64, { req: true, nonEmpty: true }),
  int('createdAt', 'created_at', { req: true }), int('decidedAt', 'decided_at'), text('decidedBy', 'decided_by_name', L.name), idf('decidedById', 'decided_by_id'),
  oneOf('decisionAttribution', 'decision_attribution', ATTRIBUTIONS), text('decisionReason', 'decision_reason', L.decisionReason),
  idf('resultOrgId', 'result_org_id'), idf('resultUserId', 'result_user_id'), oneOf('identityLink', 'identity_link', IDENTITY_LINKS),
];
const DISPUTE_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }), idf('claimId', 'claim_id', { req: true, nonEmpty: true }), oneOf('byKind', 'by_kind', ['org_user'], { req: true }),
  idf('byId', 'by_id', { req: true, nonEmpty: true }), text('byName', 'by_name', L.name), text('reason', 'reason', L.reason, { req: true, nonEmpty: true }),
  oneOf('status', 'status', ['open', 'resolved'], { req: true }), text('resolution', 'resolution', L.resolution), int('createdAt', 'created_at', { req: true }),
  int('resolvedAt', 'resolved_at'), text('resolvedBy', 'resolved_by_name', L.name), idf('resolvedById', 'resolved_by_id'), oneOf('resolutionAttribution', 'resolution_attribution', ATTRIBUTIONS),
];
const REFERENCE_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }), int('version', 'version', { req: true }), idf('supersedesId', 'supersedes_id'), idf('playerId', 'player_id', { req: true, nonEmpty: true }),
  text('playerName', 'player_name', L.name), idf('coachUserId', 'coach_user_id', { req: true, nonEmpty: true }), text('coachName', 'coach_name', L.name),
  idf('orgId', 'org_id', { req: true, nonEmpty: true }), text('orgName', 'org_name', L.name), text('roleAtTime', 'role_at_time', L.name),
  group('provenanceSnapshot', [
    idf('claimId', 'provenance_claim_id', { req: true, nonEmpty: true }), oneOf('claimType', 'provenance_claim_type', CLAIM_TYPES, { req: true }),
    oneOf('status', 'provenance_status', ['verified'], { req: true }), oneOf('method', 'provenance_method', METHODS), int('verifiedAt', 'provenance_verified_at'),
    int('snapshotAt', 'provenance_snapshot_at', { req: true }),
  ]),
  text('relationship', 'relationship', L.relationship, { req: true, nonEmpty: true }), text('capacity', 'capacity', L.capacity, { req: true }),
  int('fromYear', 'from_year'), int('toYear', 'to_year'),
  group('structured', [text('strengths', 'strengths', L.strengths, { req: true }), text('development', 'development', L.development, { req: true }), text('summary', 'summary', L.summary, { req: true, nonEmpty: true })]),
  oneOf('status', 'status', ['active', 'withdrawn', 'superseded'], { req: true }), int('withdrawnAt', 'withdrawn_at'), text('withdrawReason', 'withdraw_reason', L.withdrawReason),
  int('createdAt', 'created_at', { req: true }),
];
const INVITE_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }), idf('orgId', 'org_id', { req: true, nonEmpty: true }), idf('byUserId', 'by_user_id', { req: true, nonEmpty: true }),
  text('byName', 'by_name', L.name), text('name', 'invitee_name', L.inviteeName, { req: true, nonEmpty: true }), text('squad', 'squad', L.squad, { req: true }),
  oneOf('status', 'status', ['pending', 'accepted'], { req: true }), idf('playerId', 'player_id'), idf('targetPlayerId', 'target_player_id'),
  group('guardianApproved', [idf('guardianId', 'guardian_approved_id', { req: true, nonEmpty: true }), int('at', 'guardian_approved_at', { req: true })], { nullable: true }),
  int('createdAt', 'created_at', { req: true }), int('expiresAt', 'expires_at', { req: true }), int('acceptedAt', 'accepted_at'),
];
const CONFLICT_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }), idf('userId', 'user_id', { req: true, nonEmpty: true }), idf('orgId', 'org_id', { req: true, nonEmpty: true }),
  oneOf('kind', 'kind', CONFLICT_KINDS, { req: true }), text('subject', 'subject', L.subject, { req: true }), text('note', 'note', L.note, { req: true }),
  int('createdAt', 'created_at', { req: true }), int('withdrawnAt', 'withdrawn_at'),
];
const DOMAIN_REQUEST_SPEC = [
  idf('id', 'id', { req: true, nonEmpty: true }), idf('orgId', 'org_id', { req: true, nonEmpty: true }), text('domain', 'domain', L.domain, { req: true, nonEmpty: true }),
  idf('requestedBy', 'requested_by', { req: true, nonEmpty: true }), oneOf('status', 'status', ['email_challenge', 'requires_human_review', 'verified', 'rejected'], { req: true }),
  oneOf('method', 'method', ['official_domain_email', 'scoutbox_manual_review']), int('createdAt', 'created_at', { req: true }), int('decidedAt', 'decided_at'),
  text('decidedBy', 'decided_by_name', L.name), idf('decidedById', 'decided_by_id'),
];
const DOMAIN_SPEC = [
  idf('orgId', 'org_id', { req: true, nonEmpty: true }), text('domain', 'domain', L.domain, { req: true, nonEmpty: true }), oneOf('status', 'status', ['verified'], { req: true }),
  oneOf('method', 'method', ['official_domain_email', 'scoutbox_manual_review'], { req: true }), int('verifiedAt', 'verified_at', { req: true }), idf('addedBy', 'added_by', { req: true, nonEmpty: true }),
];

// ------------------------------------------------------------------ DDL (generated from the specs, so the columns cannot drift from the typing)
const flat = (spec) => spec.flatMap((f) => (f.group ? flat(f.group) : [f]));
const quote = (v) => `'${String(v).replace(/'/g, "''")}'`;
function columnDdl(f, { nullable = false } = {}) {
  const notNull = f.req && !nullable;
  const nn = notNull ? ' NOT NULL' : '';
  const guard = (cond) => (notNull ? `CHECK (${cond})` : `CHECK (${f.c} IS NULL OR ${cond})`);
  if (f.t === 'text') return `TEXT${nn} ${guard(`length(${f.c}) <= ${f.max}${f.nonEmpty ? ` AND length(${f.c}) > 0` : ''}`)}`;
  if (f.t === 'int') return `INTEGER${nn}${f.def !== undefined ? ` DEFAULT ${f.def}` : ''}`;
  if (f.t === 'bool') return `INTEGER${nn} ${guard(`${f.c} IN (0,1)`)}`;
  return `TEXT${nn} ${guard(`${f.c} IN (${f.vals.map(quote).join(',')})`)}`;
}
const columnsOf = (spec, inNullableGroup = false) => spec.flatMap((f) => (f.group ? columnsOf(f.group, inNullableGroup || !!f.nullable) : [{ f, nullable: inNullableGroup }]));
/** `CREATE TABLE` for a spec: its columns, then the given keys and table constraints. */
function tableDdl(name, spec, extra = []) {
  const cols = columnsOf(spec).map(({ f, nullable }) => `  ${f.c.padEnd(40)} ${f.c === 'id' ? 'TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80)' : columnDdl(f, { nullable })}`);
  return `CREATE TABLE ${name} (\n${[...cols, ...extra.map((e) => `  ${e}`)].join(',\n')}\n) STRICT;`;
}
const codeTableDdl = (name, owner, ownerTable, lists) => `CREATE TABLE ${name} (
  ${owner}  TEXT NOT NULL REFERENCES ${ownerTable}(id) ON DELETE CASCADE,
  list      TEXT NOT NULL CHECK (list IN (${Object.keys(lists).map(quote).join(',')})),
  position  INTEGER NOT NULL,
  code      TEXT NOT NULL CHECK (${Object.entries(lists).map(([l, vocab]) => `(list = ${quote(l)} AND code IN (${vocab.map(quote).join(',')}))`).join(' OR ')}),
  PRIMARY KEY (${owner}, list, position),
  UNIQUE (${owner}, list, code)
) STRICT;`;
const CLAIM_LISTS = { review_reason: REVIEW_CODES, risk_flag: RISK_FLAGS };
const ROOT_LISTS = { review_reason: REVIEW_CODES, risk_flag: RISK_FLAGS };
const DOMAIN_REQUEST_LISTS = { review_reason: REVIEW_CODES };
const OPEN_STATES_SQL = "('unverified','collecting_evidence','pending','automated_checks_passed','requires_human_review','verified')";

export const VERIFICATION_DDL = [
  tableDdl('ver_root_requests', ROOT_SPEC, ['FOREIGN KEY (existing_org_id) REFERENCES orgs(id) ON DELETE RESTRICT', 'FOREIGN KEY (result_org_id) REFERENCES orgs(id) ON DELETE RESTRICT', 'FOREIGN KEY (result_user_id) REFERENCES org_users(id) ON DELETE RESTRICT']),
  'CREATE INDEX ver_root_requests_status ON ver_root_requests (status, country);',
  'CREATE INDEX ver_root_requests_existing_org ON ver_root_requests (existing_org_id, status);',
  'CREATE INDEX ver_root_requests_result_org ON ver_root_requests (result_org_id, status);',
  codeTableDdl('ver_root_request_codes', 'root_request_id', 'ver_root_requests', ROOT_LISTS),
  tableDdl('ver_claims', CLAIM_SPEC, ['FOREIGN KEY (organisation_id) REFERENCES orgs(id) ON DELETE RESTRICT', 'FOREIGN KEY (root_request_id) REFERENCES ver_root_requests(id) ON DELETE RESTRICT',
    "CHECK (verified_by_kind IS NOT NULL OR verified_by_id IS NULL)", "CHECK (revoked_by_kind IS NOT NULL OR revoked_by_id IS NULL)", "CHECK ((flagged_at IS NULL) = (flagged_reason IS NULL))",
    "CHECK (registry_provider IS NOT NULL OR (registry_state IS NULL AND registry_result IS NULL AND registry_checked_at IS NULL AND registry_reference IS NULL))"]),
  'CREATE INDEX ver_claims_subject ON ver_claims (subject_kind, subject_id);',
  "CREATE INDEX ver_claims_authority ON ver_claims (authority_id) WHERE authority_kind = 'org_admin';",
  'CREATE INDEX ver_claims_org_subject_status ON ver_claims (organisation_id, subject_kind, status);',
  'CREATE INDEX ver_claims_status ON ver_claims (status, claim_type);',
  "CREATE INDEX ver_claims_valid_until ON ver_claims (valid_until) WHERE status = 'verified';",
  "CREATE INDEX ver_claims_revoked_at ON ver_claims (revoked_at) WHERE status = 'revoked';",
  'CREATE INDEX ver_claims_pair ON ver_claims (pair_id) WHERE pair_id IS NOT NULL;',
  `CREATE UNIQUE INDEX ver_claims_one_identity_per_user ON ver_claims (subject_id) WHERE subject_kind = 'user' AND claim_type = 'PERSON_IDENTITY' AND status IN ${OPEN_STATES_SQL};`,
  `CREATE UNIQUE INDEX ver_claims_one_current_affiliation ON ver_claims (subject_id, organisation_id, claim_type) WHERE subject_kind = 'user' AND current = 1 AND claim_type IN ('CLUB_AFFILIATION','CLUB_ROLE','AGENCY_AFFILIATION','AGENCY_ROLE','GRASSROOTS_AFFILIATION') AND status IN ${OPEN_STATES_SQL};`,
  codeTableDdl('ver_claim_codes', 'claim_id', 'ver_claims', CLAIM_LISTS),
  tableDdl('ver_evidence', EVIDENCE_SPEC, ['FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT', 'FOREIGN KEY (root_request_id) REFERENCES ver_root_requests(id) ON DELETE RESTRICT', 'CHECK (sha256 IS NULL OR length(sha256) = 64)', 'CHECK (bytes IS NULL OR (bytes > 0 AND bytes <= 8388608))']),
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
  tableDdl('ver_events', EVENT_SPEC, ['FOREIGN KEY (actor_org_id) REFERENCES orgs(id) ON DELETE RESTRICT', 'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT', 'FOREIGN KEY (claim_id) REFERENCES ver_claims(id) ON DELETE RESTRICT']),
  'CREATE INDEX ver_events_claim ON ver_events (claim_id) WHERE claim_id IS NOT NULL;',
  tableDdl('ver_tokens', TOKEN_SPEC, ['FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT', 'CHECK (length(token_hash) = 64)', 'CHECK (attempts_failed >= 0)']),
  'CREATE UNIQUE INDEX ver_tokens_hash ON ver_tokens (token_hash);',
  'CREATE INDEX ver_tokens_subject_purpose ON ver_tokens (subject_id, purpose);',
  tableDdl('ver_admins', ADMIN_SPEC, ['FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT', 'FOREIGN KEY (user_id) REFERENCES org_users(id) ON DELETE RESTRICT', 'FOREIGN KEY (revoked_by) REFERENCES org_users(id) ON DELETE RESTRICT']),
  'CREATE INDEX ver_admins_org_user ON ver_admins (org_id, user_id, status);',
  "CREATE UNIQUE INDEX ver_admins_one_active_grant ON ver_admins (org_id, user_id, level) WHERE status = 'active';",
  tableDdl('ver_root_transfers', TRANSFER_SPEC, ['FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT', 'FOREIGN KEY (to_user_id) REFERENCES org_users(id) ON DELETE RESTRICT', 'FOREIGN KEY (proposed_by) REFERENCES org_users(id) ON DELETE RESTRICT', 'FOREIGN KEY (approved_by) REFERENCES org_users(id) ON DELETE RESTRICT']),
  "CREATE UNIQUE INDEX ver_root_transfers_one_pending ON ver_root_transfers (org_id) WHERE status = 'pending';",
  tableDdl('ver_disputes', DISPUTE_SPEC, ['FOREIGN KEY (claim_id) REFERENCES ver_claims(id) ON DELETE RESTRICT', 'FOREIGN KEY (by_id) REFERENCES org_users(id) ON DELETE RESTRICT']),
  "CREATE UNIQUE INDEX ver_disputes_one_open_per_claim ON ver_disputes (claim_id) WHERE status = 'open';",
  'CREATE INDEX ver_disputes_status ON ver_disputes (status);',
  tableDdl('ver_references', REFERENCE_SPEC, ['FOREIGN KEY (supersedes_id) REFERENCES ver_references(id) ON DELETE RESTRICT', 'FOREIGN KEY (coach_user_id) REFERENCES org_users(id) ON DELETE RESTRICT', 'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT', 'FOREIGN KEY (provenance_claim_id) REFERENCES ver_claims(id) ON DELETE RESTRICT', 'CHECK (version >= 1)']),
  'CREATE INDEX ver_references_player ON ver_references (player_id, status);',
  'CREATE INDEX ver_references_org ON ver_references (org_id);',
  tableDdl('ver_player_invites', INVITE_SPEC, ['FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT', 'FOREIGN KEY (by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT', "CHECK ((status = 'accepted') = (player_id IS NOT NULL AND accepted_at IS NOT NULL))"]),
  'CREATE INDEX ver_player_invites_org_created ON ver_player_invites (org_id, created_at);',
  'CREATE INDEX ver_player_invites_player ON ver_player_invites (player_id, status);',
  tableDdl('ver_conflicts', CONFLICT_SPEC, ['FOREIGN KEY (user_id) REFERENCES org_users(id) ON DELETE RESTRICT', 'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT']),
  'CREATE INDEX ver_conflicts_org_user ON ver_conflicts (org_id, user_id);',
  'CREATE INDEX ver_conflicts_user ON ver_conflicts (user_id, withdrawn_at);',
  tableDdl('ver_domain_requests', DOMAIN_REQUEST_SPEC, ['FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT', 'FOREIGN KEY (requested_by) REFERENCES org_users(id) ON DELETE RESTRICT']),
  'CREATE INDEX ver_domain_requests_org ON ver_domain_requests (org_id);',
  'CREATE INDEX ver_domain_requests_status ON ver_domain_requests (status);',
  codeTableDdl('ver_domain_request_codes', 'domain_request_id', 'ver_domain_requests', DOMAIN_REQUEST_LISTS),
  tableDdl('org_verified_domains', DOMAIN_SPEC, ['FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT', 'PRIMARY KEY (org_id, domain)']),
  'CREATE INDEX org_verified_domains_domain ON org_verified_domains (domain);',
  `CREATE TABLE ver_migrations (
  key            TEXT PRIMARY KEY CHECK (key IN ('m14')),
  ran_at         INTEGER NOT NULL,
  claims_created INTEGER NOT NULL CHECK (claims_created >= 0)
) STRICT;`,
].join('\n');
export const VERIFICATION_TABLES = Object.freeze(['ver_root_requests', 'ver_root_request_codes', 'ver_claims', 'ver_claim_codes', 'ver_evidence', 'ver_claim_evidence', 'ver_events', 'ver_tokens', 'ver_admins', 'ver_root_transfers', 'ver_disputes', 'ver_references', 'ver_player_invites', 'ver_conflicts', 'ver_domain_requests', 'ver_domain_request_codes', 'org_verified_domains', 'ver_migrations']);

// ------------------------------------------------------------------ typing (the one place a value is judged)
export const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const bad = (at, field, what) => ({ ok: false, reason: `${at}.${field} ${what}` });
function typeScalar(f, v, at) {
  if (v === undefined && f.def !== undefined) v = f.def;
  if (v === undefined || v === null) return f.req ? bad(at, f.k, `is required (got ${describe(v)})`) : { ok: true, value: null };
  if (f.t === 'text') {
    if (typeof v !== 'string') return bad(at, f.k, `must be text (got ${describe(v)})`);
    if (v.length > f.max) return bad(at, f.k, `exceeds ${f.max} characters`);
    if (f.nonEmpty && !v.length) return bad(at, f.k, 'must not be empty');
  } else if (f.t === 'int') {
    if (!Number.isSafeInteger(v)) return bad(at, f.k, `must be an integer (got ${describe(v)})`);
  } else if (f.t === 'bool') {
    if (typeof v !== 'boolean') return bad(at, f.k, `must be true or false (got ${describe(v)})`);
  } else if (!f.vals.includes(v)) return bad(at, f.k, `must be one of ${f.vals.join('|')} (got ${describe(v)})`);
  return { ok: true, value: v };
}
/** Type `raw` against `spec`; `extra` lists keys the caller types itself. `{ ok, record }` or `{ ok: false, reason }` naming the field, never its content. */
function typeSpec(spec, raw, at, extra = []) {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const known = new Set([...spec.map((f) => f.k), ...extra]);
  const unknown = Object.keys(raw).filter((k) => !known.has(k));
  if (unknown.length) return { ok: false, reason: `${at} carries field(s) this build does not store: ${unknown.join(', ')}` };
  const out = {};
  for (const f of spec) {
    const v = raw[f.k];
    if (f.group) {
      if (v === undefined || v === null) {
        if (f.nullable) { if (!f.sparse || v === null) out[f.k] = null; continue; }
        if (f.sparse) { const t = typeSpec(f.group, {}, `${at}.${f.k}`); if (!t.ok) return t; out[f.k] = t.record; continue; }
        return bad(at, f.k, `is required (got ${describe(v)})`);
      }
      const t = typeSpec(f.group, v, `${at}.${f.k}`); if (!t.ok) return t;
      out[f.k] = f.sparse ? Object.fromEntries(Object.entries(t.record).filter(([, x]) => x !== null)) : t.record;
      continue;
    }
    const t = typeScalar(f, v, at); if (!t.ok) return t;
    out[f.k] = t.value;
  }
  return { ok: true, record: out };
}
function typeCodes(list, at, field, vocab) {
  if (list === undefined || list === null) return { ok: true, list: [] };
  if (!Array.isArray(list)) return bad(at, field, `must be a list of codes (got ${describe(list)})`);
  for (const c of list) if (!vocab.includes(c)) return bad(at, field, `holds ${describe(c)}, not one of its codes`);
  if (new Set(list).size !== list.length) return bad(at, field, 'names a code twice');
  return { ok: true, list: [...list] };
}
function typeIdList(list, at, field) {
  if (list === undefined || list === null) return { ok: true, list: [] };
  if (!Array.isArray(list) || list.some((x) => typeof x !== 'string' || !x || x.length > L.id)) return bad(at, field, 'must be a list of ids');
  if (new Set(list).size !== list.length) return bad(at, field, 'names an id twice');
  return { ok: true, list: [...list] };
}
const labelOf = (at, raw) => `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();

export function typeClaim(raw, at = 'verClaims') {
  const label = labelOf(at, raw);
  const t = typeSpec(CLAIM_SPEC, raw, label, ['evidenceIds', 'reviewReasons', 'riskFlags']); if (!t.ok) return t;
  const ev = typeIdList(raw.evidenceIds, label, 'evidenceIds'); if (!ev.ok) return ev;
  const rr = typeCodes(raw.reviewReasons, label, 'reviewReasons', REVIEW_CODES); if (!rr.ok) return rr;
  const rf = typeCodes(raw.riskFlags, label, 'riskFlags', RISK_FLAGS); if (!rf.ok) return rf;
  return { ok: true, record: { ...t.record, evidenceIds: ev.list, reviewReasons: rr.list, riskFlags: rf.list } };
}
export function typeEvidence(raw, at = 'verEvidence') {
  const label = labelOf(at, raw);
  const t = typeSpec(EVIDENCE_SPEC, raw, label, ['claimIds']); if (!t.ok) return t;
  const c = typeIdList(raw.claimIds, label, 'claimIds'); if (!c.ok) return c;
  return { ok: true, record: { ...t.record, claimIds: c.list } };
}
export function typeRootRequest(raw, at = 'verRootRequests') {
  const label = labelOf(at, raw);
  const t = typeSpec(ROOT_SPEC, raw, label, ['evidenceIds', 'reviewReasons', 'riskFlags']); if (!t.ok) return t;
  const ev = typeIdList(raw.evidenceIds, label, 'evidenceIds'); if (!ev.ok) return ev;
  const rr = typeCodes(raw.reviewReasons, label, 'reviewReasons', REVIEW_CODES); if (!rr.ok) return rr;
  const rf = typeCodes(raw.riskFlags, label, 'riskFlags', RISK_FLAGS); if (!rf.ok) return rf;
  return { ok: true, record: { ...t.record, evidenceIds: ev.list, reviewReasons: rr.list, riskFlags: rf.list } };
}
export function typeDomainRequest(raw, at = 'verDomainRequests') {
  const label = labelOf(at, raw);
  const t = typeSpec(DOMAIN_REQUEST_SPEC, raw, label, ['reviewReasons']); if (!t.ok) return t;
  const rr = typeCodes(raw.reviewReasons, label, 'reviewReasons', REVIEW_CODES); if (!rr.ok) return rr;
  return { ok: true, record: { ...t.record, reviewReasons: rr.list } };
}
const simpleTyper = (spec, fallback) => (raw, at = fallback) => typeSpec(spec, raw, labelOf(at, raw));
export const typeEvent = simpleTyper(EVENT_SPEC, 'verEvents');
export const typeToken = simpleTyper(TOKEN_SPEC, 'verTokens');
export const typeAdmin = simpleTyper(ADMIN_SPEC, 'verAdmins');
export const typeTransfer = simpleTyper(TRANSFER_SPEC, 'verRootTransfers');
export const typeDispute = simpleTyper(DISPUTE_SPEC, 'verDisputes');
export const typeReference = simpleTyper(REFERENCE_SPEC, 'verReferences');
export const typeInvite = simpleTyper(INVITE_SPEC, 'verPlayerInvites');
export const typeConflict = simpleTyper(CONFLICT_SPEC, 'verConflicts');
export function typeOrgDomain(raw, at = 'orgVerifiedDomains') {
  const t = typeSpec(DOMAIN_SPEC, raw, `${at} ${isPlainObject(raw) ? `${raw.orgId}/${raw.domain}` : ''}`.trim()); return t;
}

// ------------------------------------------------------------------ rows
const encode = (spec, rec, row = {}) => {
  for (const f of spec) {
    if (f.group) { encode(f.group, rec[f.k] ?? {}, row); continue; }
    const v = rec[f.k];
    row[f.c] = v === undefined || v === null ? null : f.t === 'bool' ? (v ? 1 : 0) : v;
  }
  return row;
};
const decode = (spec, row) => {
  const out = {};
  for (const f of spec) {
    if (f.group) {
      const inner = decode(f.group, row);
      if (f.nullable && row[f.group[0].c] === null) { if (!f.sparse) out[f.k] = null; continue; }
      out[f.k] = f.sparse ? Object.fromEntries(Object.entries(inner).filter(([, x]) => x !== null)) : inner;
      continue;
    }
    const v = row[f.c];
    out[f.k] = v === null || v === undefined ? null : f.t === 'bool' ? v === 1 : v;
  }
  return out;
};
const insertSql = (table, spec) => { const cols = flat(spec).map((f) => f.c); return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`; };
const upsertSql = (table, spec, key = ['id']) => { const cols = flat(spec).map((f) => f.c); return `${insertSql(table, spec)} ON CONFLICT(${key.join(', ')}) DO UPDATE SET ${cols.filter((c) => !key.includes(c)).map((c) => `${c} = excluded.${c}`).join(', ')}`; };

/** One entity: table, spec, typer, the record's child lists, and the queries over it. */
const ENTITIES = {
  verClaims: { table: 'ver_claims', spec: CLAIM_SPEC, type: typeClaim, codes: { table: 'ver_claim_codes', owner: 'claim_id', lists: { reviewReasons: 'review_reason', riskFlags: 'risk_flag' } }, evidenceLinks: true },
  verEvents: { table: 'ver_events', spec: EVENT_SPEC, type: typeEvent, appendOnly: true },
  verEvidence: { table: 'ver_evidence', spec: EVIDENCE_SPEC, type: typeEvidence, claimLinks: true },
  verTokens: { table: 'ver_tokens', spec: TOKEN_SPEC, type: typeToken },
  verAdmins: { table: 'ver_admins', spec: ADMIN_SPEC, type: typeAdmin },
  verRootTransfers: { table: 'ver_root_transfers', spec: TRANSFER_SPEC, type: typeTransfer },
  verRootRequests: { table: 'ver_root_requests', spec: ROOT_SPEC, type: typeRootRequest, codes: { table: 'ver_root_request_codes', owner: 'root_request_id', lists: { reviewReasons: 'review_reason', riskFlags: 'risk_flag' } }, rootEvidence: true },
  verDisputes: { table: 'ver_disputes', spec: DISPUTE_SPEC, type: typeDispute },
  verReferences: { table: 'ver_references', spec: REFERENCE_SPEC, type: typeReference },
  verPlayerInvites: { table: 'ver_player_invites', spec: INVITE_SPEC, type: typeInvite },
  verConflicts: { table: 'ver_conflicts', spec: CONFLICT_SPEC, type: typeConflict },
  verDomainRequests: { table: 'ver_domain_requests', spec: DOMAIN_REQUEST_SPEC, type: typeDomainRequest, codes: { table: 'ver_domain_request_codes', owner: 'domain_request_id', lists: { reviewReasons: 'review_reason' } } },
  orgVerifiedDomains: { table: 'org_verified_domains', spec: DOMAIN_SPEC, type: typeOrgDomain, key: ['org_id', 'domain'] },
};
/** Fields a record's update can never change. */
const IMMUTABLE = {
  verClaims: ['id', 'subjectType', 'subjectId', 'claimType', 'createdAt'], verEvidence: ['id', 'receivedAt', 'sha256', 'mediaId', 'claimIds'],
  verTokens: ['id', 'hash', 'purpose', 'createdAt'], verAdmins: ['id', 'orgId', 'userId', 'level', 'createdAt'], verRootTransfers: ['id', 'orgId', 'toUserId', 'proposedBy', 'createdAt'],
  verRootRequests: ['id', 'createdAt', 'applicantSecretHash', 'evidenceIds'], verDisputes: ['id', 'claimId', 'byKind', 'byId', 'createdAt'],
  verReferences: ['id', 'version', 'playerId', 'coachUserId', 'orgId', 'provenanceSnapshot', 'createdAt'], verPlayerInvites: ['id', 'orgId', 'byUserId', 'createdAt'],
  verConflicts: ['id', 'userId', 'orgId', 'kind', 'createdAt'], verDomainRequests: ['id', 'orgId', 'domain', 'requestedBy', 'createdAt'],
};

function statements(sqlite) {
  const out = {};
  for (const [name, e] of Object.entries(ENTITIES)) {
    out[name] = {
      upsert: sqlite.prepare(upsertSql(e.table, e.spec, e.key)),
      byId: e.key ? null : sqlite.prepare(`SELECT * FROM ${e.table} WHERE id = ?`),
      all: sqlite.prepare(`SELECT * FROM ${e.table} ORDER BY rowid`),
    };
    if (e.codes) {
      out[name].codesOf = sqlite.prepare(`SELECT * FROM ${e.codes.table} WHERE ${e.codes.owner} = ? ORDER BY list, position`);
      out[name].codesDel = sqlite.prepare(`DELETE FROM ${e.codes.table} WHERE ${e.codes.owner} = ?`);
      out[name].codeIns = sqlite.prepare(`INSERT INTO ${e.codes.table} (${e.codes.owner}, list, position, code) VALUES (?, ?, ?, ?)`);
    }
  }
  out.linksOfClaim = sqlite.prepare('SELECT * FROM ver_claim_evidence WHERE claim_id = ? ORDER BY position');
  out.linksOfEvidence = sqlite.prepare('SELECT * FROM ver_claim_evidence WHERE evidence_id = ? ORDER BY rowid');
  out.linksDel = sqlite.prepare('DELETE FROM ver_claim_evidence WHERE claim_id = ?');
  out.linkIns = sqlite.prepare('INSERT INTO ver_claim_evidence (claim_id, position, evidence_id) VALUES (?, ?, ?)');
  out.linkNext = sqlite.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS n FROM ver_claim_evidence WHERE claim_id = ?');
  out.rootEvidence = sqlite.prepare('SELECT id, root_request_id FROM ver_evidence WHERE root_request_id = ? ORDER BY rowid');
  return out;
}
/** The child rows of many records at once (one query per child table for a list). */
function childReaders(sqlite, st, name, idList) {
  const e = ENTITIES[name];
  const many = idList.length > 1;
  return {
    codes: e.codes ? (many ? childRowsOf(sqlite, e.codes.table, e.codes.owner, idList, { order: 'list, position' }) : st[name].codesOf) : null,
    links: e.evidenceLinks ? (many ? childRowsOf(sqlite, 'ver_claim_evidence', 'claim_id', idList, { order: 'position' }) : st.linksOfClaim) : null,
    claimLinks: e.claimLinks ? (many ? childRowsOf(sqlite, 'ver_claim_evidence', 'evidence_id', idList) : st.linksOfEvidence) : null,
    rootEvidence: e.rootEvidence ? (many ? childRowsOf(sqlite, 'ver_evidence', 'root_request_id', idList, { order: 'rowid' }) : st.rootEvidence) : null,
  };
}
function decodeRecord(name, row, kids) {
  const e = ENTITIES[name];
  const rec = decode(e.spec, row);
  if (e.codes) {
    const rows = kids.codes.all(row.id);
    for (const [key, list] of Object.entries(e.codes.lists)) rec[key] = rows.filter((r) => r.list === list).map((r) => r.code);
  }
  if (e.evidenceLinks) rec.evidenceIds = kids.links.all(row.id).map((r) => r.evidence_id);
  if (e.claimLinks) rec.claimIds = kids.claimLinks.all(row.id).map((r) => r.claim_id);
  if (e.rootEvidence) rec.evidenceIds = kids.rootEvidence.all(row.id).map((r) => r.id);
  return rec;
}
function writeRecord(st, name, rec) {
  const e = ENTITIES[name];
  st[name].upsert.run(encode(e.spec, rec));
  if (e.codes) {
    st[name].codesDel.run(rec.id);
    for (const [key, list] of Object.entries(e.codes.lists)) rec[key].forEach((code, i) => st[name].codeIns.run(rec.id, list, i, code));
  }
  if (e.evidenceLinks) { st.linksDel.run(rec.id); rec.evidenceIds.forEach((ev, i) => st.linkIns.run(rec.id, i, ev)); }
}

// ------------------------------------------------------------------ the event detail line
const show = (v) => (v === null || v === undefined ? '—' : Array.isArray(v) ? v.map(show).join(', ') : isPlainObject(v) ? Object.entries(v).map(([k, x]) => `${k}=${show(x)}`).join(' ') : String(v));
/** One line of text from an event's before/after payloads: `key: before → after` for each key either names. */
export function eventDetail(before, after) {
  const b = isPlainObject(before) ? before : {}; const a = isPlainObject(after) ? after : {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const parts = keys.map((k) => (k in b && k in a ? `${k}: ${show(b[k])} → ${show(a[k])}` : k in a ? `${k}: ${show(a[k])}` : `${k}: ${show(b[k])} (before)`));
  const line = parts.join('; ');
  return line ? (line.length > L.detail ? `${line.slice(0, L.detail - 1)}…` : line) : null;
}

// ------------------------------------------------------------------ the rules the code keeps, named with ids before the engine would
function checkRecords(sqlite, typed, label) {
  const problems = [];
  const orgs = new Set(sqlite.prepare('SELECT id FROM orgs').all().map((r) => r.id));
  const users = new Set(sqlite.prepare('SELECT id FROM org_users').all().map((r) => r.id));
  const idsOf = (n) => new Set(typed[n].map((r) => r.id));
  const claims = idsOf('verClaims'); const evidence = idsOf('verEvidence'); const roots = idsOf('verRootRequests'); const refs = idsOf('verReferences');
  const need = (ok, what) => { if (!ok) problems.push(what); };
  const org = (r, n, k) => { if (r[k] != null) need(orgs.has(r[k]), `${n} ${r.id ?? `${r.orgId}/${r.domain}`} ${k} → orgs ${r[k]}`); };
  const user = (r, n, k) => { if (r[k] != null) need(users.has(r[k]), `${n} ${r.id} ${k} → org_users ${r[k]}`); };
  for (const c of typed.verClaims) { org(c, 'ver_claims', 'organisationId'); for (const ev of c.evidenceIds) need(evidence.has(ev), `ver_claims ${c.id} evidenceIds → ver_evidence ${ev}`); if (c.metadata.rootRequest) need(roots.has(c.metadata.rootRequest), `ver_claims ${c.id} rootRequest → ver_root_requests ${c.metadata.rootRequest}`); }
  for (const e of typed.verEvidence) { org(e, 'ver_evidence', 'orgId'); if (e.meta.rootRequest) need(roots.has(e.meta.rootRequest), `ver_evidence ${e.id} rootRequest → ver_root_requests ${e.meta.rootRequest}`); }
  for (const e of typed.verEvents) { org(e, 'ver_events', 'orgId'); org(e, 'ver_events', 'actorOrgId'); if (e.claimId) need(claims.has(e.claimId), `ver_events ${e.id} claimId → ver_claims ${e.claimId}`); }
  for (const t of typed.verTokens) org(t, 'ver_tokens', 'orgId');
  for (const a of typed.verAdmins) { org(a, 'ver_admins', 'orgId'); user(a, 'ver_admins', 'userId'); user(a, 'ver_admins', 'revokedBy'); }
  for (const t of typed.verRootTransfers) { org(t, 'ver_root_transfers', 'orgId'); for (const k of ['toUserId', 'proposedBy', 'approvedBy']) user(t, 'ver_root_transfers', k); }
  for (const r of typed.verRootRequests) { org(r, 'ver_root_requests', 'existingOrgId'); org(r, 'ver_root_requests', 'resultOrgId'); user(r, 'ver_root_requests', 'resultUserId'); }
  for (const d of typed.verDisputes) { need(claims.has(d.claimId), `ver_disputes ${d.id} claimId → ver_claims ${d.claimId}`); user(d, 'ver_disputes', 'byId'); }
  for (const r of typed.verReferences) { org(r, 'ver_references', 'orgId'); user(r, 'ver_references', 'coachUserId'); need(claims.has(r.provenanceSnapshot.claimId), `ver_references ${r.id} provenance → ver_claims ${r.provenanceSnapshot.claimId}`); if (r.supersedesId) need(refs.has(r.supersedesId), `ver_references ${r.id} supersedesId → ver_references ${r.supersedesId}`); }
  for (const i of typed.verPlayerInvites) { org(i, 'ver_player_invites', 'orgId'); user(i, 'ver_player_invites', 'byUserId'); }
  for (const c of typed.verConflicts) { org(c, 'ver_conflicts', 'orgId'); user(c, 'ver_conflicts', 'userId'); }
  for (const r of typed.verDomainRequests) { org(r, 'ver_domain_requests', 'orgId'); user(r, 'ver_domain_requests', 'requestedBy'); }
  for (const d of typed.orgVerifiedDomains) org(d, 'org_verified_domains', 'orgId');
  if (problems.length) throw refusal('VERIFICATION_REFERENCE_MISSING', `${problems.length} reference(s) in ${label} name a row that is not there (${ids(problems)}); the write was rolled back and nothing was changed`, { rows: problems });
  const unique = []; const seen = new Map();
  const once = (key, what) => { if (seen.has(key)) unique.push(`${what} (${seen.get(key)})`); else seen.set(key, what); };
  const open = ['unverified', 'collecting_evidence', 'pending', 'automated_checks_passed', 'requires_human_review', 'verified'];
  for (const c of typed.verClaims) {
    if (c.subjectType === 'user' && c.claimType === 'PERSON_IDENTITY' && open.includes(c.status)) once(`identity/${c.subjectId}`, `one open identity claim per user: ${c.id}`);
    if (c.subjectType === 'user' && c.current && ['CLUB_AFFILIATION', 'CLUB_ROLE', 'AGENCY_AFFILIATION', 'AGENCY_ROLE', 'GRASSROOTS_AFFILIATION'].includes(c.claimType) && open.includes(c.status)) once(`aff/${c.subjectId}/${c.organisationId}/${c.claimType}`, `one current affiliation per user, organisation and type: ${c.id}`);
  }
  for (const t of typed.verTokens) once(`token/${t.hash}`, `one token per hash: ${t.id}`);
  for (const a of typed.verAdmins) if (a.status === 'active') once(`admin/${a.orgId}/${a.userId}/${a.level}`, `one active grant per organisation, person and level: ${a.id}`);
  for (const t of typed.verRootTransfers) if (t.status === 'pending') once(`transfer/${t.orgId}`, `one pending root transfer per organisation: ${t.id}`);
  for (const d of typed.verDisputes) if (d.status === 'open') once(`dispute/${d.claimId}`, `one open dispute per claim: ${d.id}`);
  for (const d of typed.orgVerifiedDomains) once(`domain/${d.orgId}/${d.domain}`, `one entry per organisation and domain: ${d.orgId}/${d.domain}`);
  for (const i of typed.verPlayerInvites) if ((i.status === 'accepted') !== (i.playerId !== null && i.acceptedAt !== null)) unique.push(`an accepted invitation names its player and time: ${i.id}`);
  if (unique.length) throw refusal('VERIFICATION_UNIQUENESS', `${unique.length} rule(s) violated in ${label}: ${ids(unique)}; the write was rolled back and nothing was changed`, { rows: unique });
}
function typeCollections(supplied, label) {
  const typed = {};
  for (const name of VERIFICATION_COLLECTIONS) {
    const list = supplied[name]; typed[name] = [];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw refusal('VERIFICATION_IMPORT_BLOCKED', `the ${name} collection of ${label} must be an array of entries (got ${describe(list)})`);
    const seen = new Set();
    list.forEach((raw, i) => {
      const t = ENTITIES[name].type(raw, `${name} entry #${i}`);
      if (!t.ok) throw refusal('VERIFICATION_IMPORT_BLOCKED', `${label}: ${t.reason}`);
      const key = name === 'orgVerifiedDomains' ? `${t.record.orgId}/${t.record.domain}` : t.record.id;
      if (seen.has(key)) throw refusal('VERIFICATION_IMPORT_BLOCKED', `${label}: ${name} entry #${i} duplicates the id of an earlier entry (${key})`);
      seen.add(key); typed[name].push(t.record);
    });
  }
  return typed;
}
export const verificationLive = (sqlite) => migrationApplied(sqlite, VERIFICATION_MIGRATION);
function readAll(sqlite) {
  const st = statements(sqlite);
  const out = {};
  for (const name of VERIFICATION_COLLECTIONS) {
    const rows = st[name].all.all();
    const kids = childReaders(sqlite, st, name, rows.map((r) => r.id).filter(Boolean));
    out[name] = rows.map((r) => decodeRecord(name, r, kids));
  }
  return out;
}
/** Insertion order for a whole rewrite: the parents before the rows that name them. */
const WRITE_ORDER = ['verRootRequests', 'verEvidence', 'verClaims', 'verEvents', 'verTokens', 'verAdmins', 'verRootTransfers', 'verDisputes', 'verReferences', 'verPlayerInvites', 'verConflicts', 'verDomainRequests', 'orgVerifiedDomains'];
const DELETE_ORDER = ['ver_events', 'ver_disputes', 'ver_references', 'ver_claim_evidence', 'ver_claim_codes', 'ver_claims', 'ver_evidence', 'ver_root_request_codes', 'ver_root_requests', 'ver_tokens', 'ver_admins', 'ver_root_transfers', 'ver_player_invites', 'ver_conflicts', 'ver_domain_request_codes', 'ver_domain_requests', 'org_verified_domains'];

/**
 * Whole-snapshot access (readTableBacked / writeTableBacked). A supplied collection IS the whole final collection; an
 * omitted one is kept whole. Every record is typed (junk refused with ids) and every reference and uniqueness rule of
 * the FINAL combined state is named before the engine would; then the domain's tables are rewritten from that state.
 */
export const VERIFICATION_SNAPSHOT = {
  names: VERIFICATION_COLLECTIONS,
  read(sqlite) { return verificationLive(sqlite) ? readAll(sqlite) : null; },
  replace(sqlite, db, { label = 'the snapshot (verification)' } = {}) {
    if (!verificationLive(sqlite)) return [];
    const supplied = Object.fromEntries(VERIFICATION_COLLECTIONS.map((n) => [n, Object.hasOwn(db, n) ? db[n] : undefined]));
    const written = VERIFICATION_COLLECTIONS.filter((n) => supplied[n] !== undefined);
    if (!written.length) return [];
    const typed = typeCollections(supplied, label);
    const stored = readAll(sqlite);
    const final = Object.fromEntries(VERIFICATION_COLLECTIONS.map((n) => [n, supplied[n] === undefined ? stored[n] : typed[n]]));
    // a root application's evidence is the evidence that names it; a supplied evidenceIds list must agree
    for (const r of final.verRootRequests) {
      const named = final.verEvidence.filter((e) => e.meta.rootRequest === r.id).map((e) => e.id);
      if (supplied.verRootRequests !== undefined && r.evidenceIds.length && JSON.stringify(r.evidenceIds) !== JSON.stringify(named)) throw refusal('VERIFICATION_IMPORT_BLOCKED', `${label}: verRootRequests ${r.id} lists evidence that does not name it (the evidence's meta.rootRequest is the link)`);
    }
    checkRecords(sqlite, final, label);
    for (const t of DELETE_ORDER) sqlite.exec(`DELETE FROM ${t}`);
    const st = statements(sqlite);
    for (const name of WRITE_ORDER) {
      if (name === 'verReferences') {
        for (const r of final.verReferences) writeRecord(st, name, { ...r, supersedesId: null });
        for (const r of final.verReferences) if (r.supersedesId) sqlite.prepare('UPDATE ver_references SET supersedes_id = ? WHERE id = ?').run(r.supersedesId, r.id);
        continue;
      }
      for (const r of final[name]) writeRecord(st, name, r);
    }
    // evidence's claimIds: links the claims did not list are added after the claims' own (in the evidence's order)
    for (const e of final.verEvidence) for (const c of e.claimIds) {
      if (!final.verClaims.some((x) => x.id === c)) throw refusal('VERIFICATION_REFERENCE_MISSING', `${label}: ver_evidence ${e.id} claimIds → ver_claims ${c}`);
      if (!sqlite.prepare('SELECT 1 FROM ver_claim_evidence WHERE claim_id = ? AND evidence_id = ?').get(c, e.id)) st.linkIns.run(c, st.linkNext.get(c).n, e.id);
    }
    return written;
  },
  assert(sqlite, { label = 'the snapshot (verification)' } = {}) {
    if (!verificationLive(sqlite)) return;
    for (const t of VERIFICATION_TABLES) {
      const broken = sqlite.prepare(`PRAGMA foreign_key_check(${t})`).all();
      if (broken.length) throw refusal('VERIFICATION_KEY_VIOLATION', `${label}: ${t} holds ${broken.length} row(s) whose reference is not there (first: rowid ${broken[0].rowid} → ${broken[0].parent}); the write was rolled back`);
    }
  },
};
const PLAYER_REFS_SQL = 'SELECT player_id AS pid FROM ver_references UNION ALL SELECT player_id FROM ver_player_invites WHERE player_id IS NOT NULL UNION ALL SELECT target_player_id FROM ver_player_invites WHERE target_player_id IS NOT NULL';
const playerRefCount = (sqlite, cond) => sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE ${cond}`).get().n;
export const unresolvedPlayerReferences = (sqlite) => (verificationLive(sqlite) ? { verification: playerRefCount(sqlite, 'NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)') } : null);
export const retainedPlayerReferences = (sqlite) => (verificationLive(sqlite) ? { verification: playerRefCount(sqlite, 'EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)') } : null);

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'update', 'append', 'add', 'remove', 'recordBootstrap']);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
/**
 * `createVerificationRepository({ sqlite, unit, now, log })`: one object per record kind (`claims`, `events`,
 * `evidence`, `tokens`, `admins`, `rootTransfers`, `rootRequests`, `disputes`, `references`, `playerInvites`,
 * `conflicts`, `domainRequests`, `domains`), each with its writes and queries, plus `reads` (the queries alone, for
 * `verificationReads`).
 */
export function createVerificationRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the verification repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const prepared = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = sqlite.prepare(sql))); return s; };
  const decodeRows = (name, rows) => { const kids = childReaders(sqlite, st, name, rows.map((r) => r.id)); return rows.map((r) => deepFreeze(decodeRecord(name, r, kids))); };
  const read = (name, id) => { if (typeof id !== 'string') return null; const row = st[name].byId.get(id); return row ? decodeRows(name, [row])[0] : null; };
  const must = (name, id) => { const r = read(name, id); if (!r) throw refusal('VERIFICATION_NOT_FOUND', `${ENTITIES[name].table} ${id} is not a record of the repository`); return r; };
  const list = (name, where, order = 'rowid') => (...args) => decodeRows(name, prepared(`SELECT * FROM ${ENTITIES[name].table} WHERE ${where} ORDER BY ${order}`).all(...args));
  const one = (name, where) => (...args) => { const row = prepared(`SELECT * FROM ${ENTITIES[name].table} WHERE ${where} ORDER BY rowid LIMIT 1`).get(...args); return row ? decodeRows(name, [row])[0] : null; };
  const count = (table, where) => (...args) => prepared(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n;
  const typedOr = (name, raw) => { const t = ENTITIES[name].type(raw, name); if (!t.ok) throw refusal('VERIFICATION_INPUT_INVALID', t.reason); return t.record; };
  const updating = new Set();

  const create = (name) => (raw) => operation(() => {
    const r = typedOr(name, raw);
    if (st[name].byId.get(r.id)) throw refusal('VERIFICATION_DUPLICATE', `${ENTITIES[name].table} ${r.id} already exists`);
    if (name === 'verRootRequests' && r.evidenceIds.length) throw refusal('VERIFICATION_INPUT_INVALID', `ver_root_requests ${r.id}: an application starts without evidence (evidence names its application)`);
    writeRecord(st, name, r);
    if (name === 'verEvidence') for (const c of r.claimIds) {
      if (!st.verClaims.byId.get(c)) throw refusal('VERIFICATION_INPUT_INVALID', `ver_evidence ${r.id}: claimIds names ${c}, which is not a claim`);
      st.linkIns.run(c, st.linkNext.get(c).n, r.id);
    }
    return must(name, r.id);
  });
  /**
   * `update(id, change)`: `change` receives a plain copy of the stored record and edits it (or returns a replacement);
   * the result is typed whole and written at once. Identifiers and creation facts cannot change.
   */
  const update = (name) => (id, change) => {
    if (typeof change !== 'function') throw new TypeError(`${name}.update(id, change) needs a function that edits the copy it is given`);
    const key = `${name}/${id}`;
    if (updating.has(key)) throw refusal('VERIFICATION_NESTED_UPDATE', `${ENTITIES[name].table} ${id} is already being updated; make the second change after the first returns`);
    updating.add(key);
    try {
      return operation(() => {
        const stored = must(name, id);
        const draft = clone(stored);
        const returned = change(draft);
        const next = typedOr(name, returned === undefined ? draft : returned);
        for (const k of IMMUTABLE[name] ?? ['id']) if (JSON.stringify(next[k]) !== JSON.stringify(stored[k])) throw refusal('VERIFICATION_INPUT_INVALID', `${ENTITIES[name].table} ${id}: ${k} cannot change`);
        writeRecord(st, name, next); return must(name, id);
      });
    } finally { updating.delete(key); }
  };
  const OPEN = OPEN_STATES_SQL;

  const claims = {
    create: create('verClaims'), update: update('verClaims'),
    byId: (id) => read('verClaims', id),
    /** A subject's claims, oldest first (the public profile, the subject's own view). */
    forSubject: list('verClaims', 'subject_kind = ? AND subject_id = ?'),
    /** Every claim on subject id `id` whatever its kind (the Trust Score's identity source). */
    forSubjectId: list('verClaims', 'subject_id = ?'),
    /** The claims an organisation administrator approved (the authority cascade). */
    byAuthority: list('verClaims', "authority_kind = 'org_admin' AND authority_id = ?"),
    /** An organisation's staff claims (subject a user), oldest first. */
    forOrgStaff: list('verClaims', "organisation_id = ? AND subject_kind = 'user'"),
    /** One person's claims at one organisation. */
    forOrgSubject: list('verClaims', "organisation_id = ? AND subject_kind = 'user' AND subject_id = ?"),
    /** The claims of one affiliation/role pair. */
    byPair: list('verClaims', 'pair_id = ?'),
    /** Claims in any of `statuses` (a JSON list), optionally of one organisation and type: the T&S queue. */
    inStatuses: (statuses, { orgId = null, claimType = null } = {}) => decodeRows('verClaims', prepared('SELECT * FROM ver_claims WHERE status IN (SELECT value FROM json_each(?)) AND (? IS NULL OR organisation_id = ?) AND (? IS NULL OR claim_type = ?) ORDER BY rowid').all(JSON.stringify(statuses), orgId, orgId, claimType, claimType)),
    /** Verified claims whose validUntil falls in (from, until): expiring soon. */
    expiringBetween: list('verClaims', "status = 'verified' AND valid_until > ? AND valid_until < ?"),
    /** Claims revoked since `since`. */
    revokedSince: list('verClaims', "status = 'revoked' AND revoked_at > ?"),
    /** The sweep: verified current claims past their exclusive expiry. */
    expiredBy: list('verClaims', "status = 'verified' AND current = 1 AND valid_until IS NOT NULL AND valid_until < ?"),
    /** The sweep: verified claims expiring in (now, until) not yet warned. */
    warnDue: list('verClaims', "status = 'verified' AND valid_until > ? AND valid_until < ? AND expiry_warned_at IS NULL"),
    /** Has user `userId` an open or verified identity claim? */
    hasOpenIdentity: (userId) => !!prepared(`SELECT 1 FROM ver_claims WHERE subject_kind = 'user' AND subject_id = ? AND claim_type = 'PERSON_IDENTITY' AND status IN ${OPEN}`).get(userId),
    count: () => prepared('SELECT COUNT(*) AS n FROM ver_claims').get().n,
  };
  const events = {
    /** Append one event (the log is append-only). */
    append: (raw) => operation(() => { const r = typedOr('verEvents', raw); if (st.verEvents.byId.get(r.id)) throw refusal('VERIFICATION_DUPLICATE', `ver_events ${r.id} already exists`); writeRecord(st, 'verEvents', r); return must('verEvents', r.id); }),
    forClaim: list('verEvents', 'claim_id = ?'),
  };
  const evidence = {
    create: create('verEvidence'), update: update('verEvidence'),
    byId: (id) => read('verEvidence', id),
    /** A claim's evidence, in the claim's order. */
    forClaim: (claimId) => decodeRows('verEvidence', prepared('SELECT e.* FROM ver_claim_evidence l JOIN ver_evidence e ON e.id = l.evidence_id WHERE l.claim_id = ? ORDER BY l.position').all(claimId)),
    /** Evidence records `ids`, in that order (missing ids skipped). */
    byIds: (idList) => { const rows = prepared('SELECT * FROM ver_evidence WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(idList ?? [])); const byKey = new Map(decodeRows('verEvidence', rows).map((e) => [e.id, e])); return (idList ?? []).map((i) => byKey.get(i)).filter(Boolean); },
    /** Does any evidence carry digest `sha` (optionally supplied by someone other than `exceptSupplier`)? */
    digestSeen: (sha, exceptSupplier = null) => !!prepared('SELECT 1 FROM ver_evidence WHERE sha256 = ? AND (? IS NULL OR supplied_by_id IS NOT ?) LIMIT 1').get(sha, exceptSupplier, exceptSupplier),
  };
  const tokens = {
    create: create('verTokens'), update: update('verTokens'),
    byId: (id) => read('verTokens', id),
    byHash: one('verTokens', 'token_hash = ?'),
    /** Open (unused) tokens of `subjectId` for `purpose`. */
    openFor: list('verTokens', 'subject_id = ? AND purpose = ? AND used_at IS NULL'),
    /** The failed attempts recorded on `subjectId`'s tokens for `purpose`. */
    failedAttempts: (subjectId, purpose) => prepared('SELECT COALESCE(SUM(attempts_failed), 0) AS n FROM ver_tokens WHERE subject_id = ? AND purpose = ?').get(subjectId, purpose).n,
  };
  const admins = {
    create: create('verAdmins'), update: update('verAdmins'),
    byId: (id) => read('verAdmins', id),
    forOrg: list('verAdmins', 'org_id = ?'),
    activeForOrg: list('verAdmins', "org_id = ? AND status = 'active'"),
    activeFor: list('verAdmins', "org_id = ? AND user_id = ? AND status = 'active'"),
    activeRootCount: count('ver_admins', "org_id = ? AND level = 'verification_root_admin' AND status = 'active'"),
  };
  const rootTransfers = {
    create: create('verRootTransfers'), update: update('verRootTransfers'),
    byId: (id) => read('verRootTransfers', id),
    forOrg: list('verRootTransfers', 'org_id = ?'),
    hasPending: (orgId) => !!prepared("SELECT 1 FROM ver_root_transfers WHERE org_id = ? AND status = 'pending'").get(orgId),
  };
  const rootRequests = {
    create: create('verRootRequests'), update: update('verRootRequests'),
    byId: (id) => read('verRootRequests', id),
    /** An open application for the same domain or organisation name (case-insensitive). */
    openDuplicate: one('verRootRequests', "status IN ('requires_human_review','collecting_evidence') AND (domain = ? OR lower(trim(org_name)) = ?)"),
    /** Applications awaiting T&S (optionally of one country). */
    awaitingReview: (country = null) => decodeRows('verRootRequests', prepared("SELECT * FROM ver_root_requests WHERE status IN ('requires_human_review','collecting_evidence') AND (? IS NULL OR country = ?) ORDER BY rowid").all(country, country)),
    /** Is an application for organisation `orgId` still open? */
    openForOrg: (orgId) => !!prepared("SELECT 1 FROM ver_root_requests WHERE (existing_org_id = ? OR result_org_id = ?) AND status IN ('requires_human_review','collecting_evidence') LIMIT 1").get(orgId, orgId),
  };
  const disputes = {
    create: create('verDisputes'), update: update('verDisputes'),
    byId: (id) => read('verDisputes', id),
    all: list('verDisputes', '1 = 1'),
    open: list('verDisputes', "status = 'open'"),
    forClaim: list('verDisputes', 'claim_id = ?'),
    hasOpen: (claimId) => !!prepared("SELECT 1 FROM ver_disputes WHERE claim_id = ? AND status = 'open'").get(claimId),
    /** Open disputes on organisation `orgId`'s staff claims. */
    openCountForOrg: (orgId) => prepared("SELECT COUNT(*) AS n FROM ver_disputes d JOIN ver_claims c ON c.id = d.claim_id WHERE d.status = 'open' AND c.organisation_id = ? AND c.subject_kind = 'user'").get(orgId).n,
  };
  const references = {
    create: create('verReferences'), update: update('verReferences'),
    byId: (id) => read('verReferences', id),
    forOrg: list('verReferences', 'org_id = ?'),
    /** A player's references, every status. */
    forPlayer: list('verReferences', 'player_id = ?'),
    /** A player's active references. */
    activeForPlayer: list('verReferences', "player_id = ? AND status = 'active'"),
    hasActive: (playerId) => !!prepared("SELECT 1 FROM ver_references WHERE player_id = ? AND status = 'active' LIMIT 1").get(playerId),
  };
  const playerInvites = {
    create: create('verPlayerInvites'), update: update('verPlayerInvites'),
    byId: (id) => read('verPlayerInvites', id),
    forOrg: list('verPlayerInvites', 'org_id = ?'),
    countSince: count('ver_player_invites', 'org_id = ? AND created_at > ?'),
    acceptedForPlayer: list('verPlayerInvites', "player_id = ? AND status = 'accepted'"),
  };
  const conflicts = {
    create: create('verConflicts'), update: update('verConflicts'),
    byId: (id) => read('verConflicts', id),
    forOrg: list('verConflicts', 'org_id = ?'),
    forOrgUser: list('verConflicts', 'org_id = ? AND user_id = ?'),
    activeForUser: list('verConflicts', 'user_id = ? AND withdrawn_at IS NULL'),
  };
  const domainRequests = {
    create: create('verDomainRequests'), update: update('verDomainRequests'),
    byId: (id) => read('verDomainRequests', id),
    forOrg: list('verDomainRequests', 'org_id = ?'),
    awaitingReview: list('verDomainRequests', "status = 'requires_human_review'"),
  };
  const domainRow = (orgId, domain) => prepared('SELECT * FROM org_verified_domains WHERE org_id = ? AND domain = ?').get(orgId, domain);
  const domains = {
    /** An organisation's verified domains, in the order they were added. */
    forOrg: (orgId) => prepared('SELECT * FROM org_verified_domains WHERE org_id = ? ORDER BY rowid').all(orgId).map((r) => deepFreeze(decode(DOMAIN_SPEC, r))).map(({ orgId: _o, ...d }) => d),
    has: (orgId, domain) => !!domainRow(orgId, domain),
    /** The organisation other than `exceptOrgId` that verified `domain`, or null. */
    verifiedElsewhere: (domain, exceptOrgId = null) => prepared('SELECT org_id FROM org_verified_domains WHERE domain = ? AND (? IS NULL OR org_id <> ?) ORDER BY rowid LIMIT 1').get(domain, exceptOrgId, exceptOrgId)?.org_id ?? null,
    add: (orgId, entry) => operation(() => {
      const t = typeOrgDomain({ orgId, ...entry }); if (!t.ok) throw refusal('VERIFICATION_INPUT_INVALID', t.reason);
      if (domainRow(orgId, t.record.domain)) throw refusal('VERIFICATION_DUPLICATE', `org_verified_domains ${orgId}/${t.record.domain} already exists`);
      st.orgVerifiedDomains.upsert.run(encode(DOMAIN_SPEC, t.record));
      return deepFreeze({ domain: t.record.domain, status: t.record.status, method: t.record.method, verifiedAt: t.record.verifiedAt, addedBy: t.record.addedBy });
    }),
    remove: (orgId, domain) => operation(() => prepared('DELETE FROM org_verified_domains WHERE org_id = ? AND domain = ?').run(orgId, domain).changes > 0),
  };
  const bootstrapMarker = {
    /** Has the one-time M14 bootstrap (claims for organisations already verified) run on this database? */
    ran: () => !!prepared("SELECT 1 FROM ver_migrations WHERE key = 'm14'").get(),
    recordBootstrap: (at, claimsCreated) => operation(() => { prepared("INSERT INTO ver_migrations (key, ran_at, claims_created) VALUES ('m14', ?, ?)").run(at, claimsCreated); }),
  };
  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const counters = Object.fromEntries(VERIFICATION_COLLECTIONS.map((n) => [n, sqlite.prepare(`SELECT COUNT(*) AS n FROM ${ENTITIES[n].table}`)]));
  const repo = { claims, events, evidence, tokens, admins, rootTransfers, rootRequests, disputes, references, playerInvites, conflicts, domainRequests, domains, bootstrap: bootstrapMarker };
  return {
    ...repo,
    /** The queries alone, for modules and projectors that must not write (`verificationReads`). */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).filter(([k]) => k !== 'bootstrap').map(([k, v]) => [k, readOnly(v)]))),
    /** Run `fn` as one transaction of this repository (joined into an open unit of work). */
    atomically: (fn) => operation(fn),
    attach() {
      if (!verificationLive(sqlite)) throw new Error(`the verification repository needs ${VERIFICATION_MIGRATION} recorded; it never imports an in-memory array`);
      return { counts: this.counts() };
    },
    counts() { return Object.fromEntries(VERIFICATION_COLLECTIONS.map((n) => [n, counters[n].get().n])); },
    pending: () => 0,
    exportAll() { return VERIFICATION_SNAPSHOT.read(sqlite); },
    log,
    now,
  };
}
