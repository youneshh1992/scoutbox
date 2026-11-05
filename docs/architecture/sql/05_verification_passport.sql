-- =============================================================================
-- 05_verification_passport.sql — ScoutBox target relational schema
-- Scope: M14 Verification & Trust (verClaims, verEvents, verEvidence,
--        verTokens, verAdmins, verRootRequests, verRootTransfers, verDisputes,
--        verReferences, verPlayerInvites, verConflicts, verDomainRequests,
--        verMigrated, orgs[].verification.domains[]), M15 Football Passport
--        (passportPrefs, passportCareerEntries, passportAchievements,
--        passportShares, passportCorrections), M13 F2 transitionCases,
--        and core vouches. (The M13 F10 legacy representations were removed in S11a: no table.)
-- Depends on: 01_identity.sql (orgs, org_users, players, guardians) and
--             02_recruitment.sql (evidence, assessments).
-- Conventions: docs/architecture/sql conventions (STRICT tables, snake_case,
--   epoch-ms INTEGER *_at, hashed secrets, *_json only with a stated reason).
-- S10a, S10b and S10c: the verification, passport, transition and reference tables are implemented and carry NO JSON
-- column (see their sections).
-- =============================================================================


-- ----------------------------------------------------------------------------
-- S10a: IMPLEMENTED, migration 0023_verification REGISTERED (repositories/verification.mjs, 4 Nov 2026).
-- The definitions below are the migration's DDL (generated from the repository's field specs, so typing, rows and
-- columns cannot drift); scripts/testSchemaDdl.mjs compares them column by column.
-- Sources: domains/verification/claims/ (index.mjs, organisations.mjs, review.mjs, shared.mjs); the signing,
-- offer and transaction documents filed through the same vault (domains/recruitment/signings, offers; m26).
-- How the model differs from the first draft of this file:
--   * No JSON columns. A claim's metadata is a fixed set of optional typed columns (declared_name … expiry_warned_at;
--     the registry result and the authority-cascade flag are column groups); an evidence record's meta likewise
--     (note … label); review reasons and risk flags are code rows (ver_claim_codes, ver_root_request_codes,
--     ver_domain_request_codes) with their vocabularies; a root application's declarations are one boolean
--     (declared_authorised); an event's before/after payload is one line of text (detail).
--   * Dropped: ver_claim_history (claims.history was never written past []), supersedes_claim_id (never assigned),
--     the licence's raw issueDate/expiry metadata (the same days are valid_from / valid_until), the org facet's
--     orgType (never read) and its column orgs.verification_org_type.
--   * ver_root_request_evidence is gone: a root application's evidence is the evidence whose root_request_id names it.
--   * The claim↔evidence link table keeps the claim's order (position); evidence.claimIds is read from it.
--   * orgs.verification.revokedAt is the orgs column verification_revoked_at (the record field verificationRevokedAt),
--     01_identity.sql; the domains list is org_verified_domains.
--   * Player ids (references, invitations, tokens) carry no foreign key: tolerant, like recruitment and scouting.
--     Every org and staff key is immediate RESTRICT (organisations are never deleted, O2); keys inside the domain
--     (a claim's evidence, a dispute's or a reference's claim, a reference's predecessor, root applications) RESTRICT.
--   * ver_migrations holds the one boot marker 'm14': organisations already verified (the seed) become migration
--     claims once per database.
-- ----------------------------------------------------------------------------
CREATE TABLE ver_root_requests (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  status                                   TEXT NOT NULL CHECK (status IN ('collecting_evidence','requires_human_review','approved','rejected')),
  org_name                                 TEXT NOT NULL CHECK (length(org_name) <= 120 AND length(org_name) > 0),
  org_type                                 TEXT NOT NULL CHECK (org_type IN ('professional club','academy','grassroots club','federation/association','agency','other approved football organisation')),
  country                                  TEXT NOT NULL CHECK (length(country) <= 40),
  federation                               TEXT CHECK (federation IS NULL OR length(federation) <= 80),
  website                                  TEXT NOT NULL CHECK (length(website) <= 200),
  domain                                   TEXT NOT NULL CHECK (length(domain) <= 253),
  applicant_name                           TEXT NOT NULL CHECK (length(applicant_name) <= 80 AND length(applicant_name) > 0),
  applicant_role                           TEXT NOT NULL CHECK (length(applicant_role) <= 60),
  work_email                               TEXT NOT NULL CHECK (length(work_email) <= 254 AND length(work_email) > 0),
  official_contact                         TEXT CHECK (official_contact IS NULL OR length(official_contact) <= 200),
  declared_authorised                      INTEGER CHECK (declared_authorised IS NULL OR declared_authorised IN (0,1)),
  check_email_syntax                       TEXT NOT NULL CHECK (check_email_syntax IN ('passed')),
  check_email_domain_alignment             TEXT NOT NULL CHECK (check_email_domain_alignment IN ('passed','mismatch')),
  check_free_email_provider                TEXT NOT NULL CHECK (check_free_email_provider IN ('passed','flagged')),
  check_disposable_email                   TEXT NOT NULL CHECK (check_disposable_email IN ('passed','flagged')),
  check_domain_normalized                  TEXT NOT NULL CHECK (length(check_domain_normalized) <= 263),
  check_dns_ownership                      TEXT NOT NULL CHECK (check_dns_ownership IN ('not_configured')),
  check_duplicate_organisation             TEXT NOT NULL CHECK (check_duplicate_organisation IN ('passed','flagged')),
  check_duplicate_request                  TEXT NOT NULL CHECK (check_duplicate_request IN ('passed','flagged')),
  check_domain_already_verified_elsewhere  TEXT NOT NULL CHECK (check_domain_already_verified_elsewhere IN ('passed','flagged')),
  check_evidence_completeness              TEXT NOT NULL CHECK (check_evidence_completeness IN ('pending_email_proof','email_proved')),
  email_proved                             INTEGER NOT NULL CHECK (email_proved IN (0,1)),
  existing_org_id                          TEXT CHECK (existing_org_id IS NULL OR length(existing_org_id) <= 80),
  applicant_secret_hash                    TEXT NOT NULL CHECK (length(applicant_secret_hash) <= 64 AND length(applicant_secret_hash) > 0),
  created_at                               INTEGER NOT NULL,
  decided_at                               INTEGER,
  decided_by_name                          TEXT CHECK (decided_by_name IS NULL OR length(decided_by_name) <= 200),
  decided_by_id                            TEXT CHECK (decided_by_id IS NULL OR length(decided_by_id) <= 80),
  decision_attribution                     TEXT CHECK (decision_attribution IS NULL OR decision_attribution IN ('authenticated_reviewer','declared_reviewer','shared_admin_key')),
  decision_reason                          TEXT CHECK (decision_reason IS NULL OR length(decision_reason) <= 400),
  result_org_id                            TEXT CHECK (result_org_id IS NULL OR length(result_org_id) <= 80),
  result_user_id                           TEXT CHECK (result_user_id IS NULL OR length(result_user_id) <= 80),
  identity_link                            TEXT CHECK (identity_link IS NULL OR identity_link IN ('trust_safety_selection','provisioned_new_user','verified_work_email')),
  FOREIGN KEY (existing_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (result_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (result_user_id) REFERENCES org_users(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ver_root_requests_status ON ver_root_requests (status, country);
CREATE INDEX ver_root_requests_existing_org ON ver_root_requests (existing_org_id, status);
CREATE INDEX ver_root_requests_result_org ON ver_root_requests (result_org_id, status);
CREATE TABLE ver_root_request_codes (
  root_request_id  TEXT NOT NULL REFERENCES ver_root_requests(id) ON DELETE CASCADE,
  list      TEXT NOT NULL CHECK (list IN ('review_reason','risk_flag')),
  position  INTEGER NOT NULL,
  code      TEXT NOT NULL CHECK ((list = 'review_reason' AND code IN ('ROOT_ORGANISATION_BOOTSTRAP','NO_AUTHORITATIVE_SOURCE','CONFLICTING_EVIDENCE','IDENTITY_MISMATCH','DOMAIN_OWNERSHIP_AMBIGUOUS','DUPLICATE_ORGANISATION','HIGH_RISK_ADMIN_CHANGE','DOCUMENT_AUTHENTICITY_UNCONFIRMED','REGISTRY_AMBIGUOUS_MATCH','DISPUTED_CLAIM','SUSPECTED_FRAUD_SIGNALS','MANUAL_EXCEPTION_REQUESTED','REGISTRY_RECORD_UNREADABLE')) OR (list = 'risk_flag' AND code IN ('DISPOSABLE_EMAIL','FREE_EMAIL_PROVIDER','ORG_DOMAIN_MISMATCH','REPEATED_EMAIL_CHALLENGE_FAILURES','COMPETING_ORGANISATION_CLAIMS','CREDENTIAL_REUSED_ACROSS_USERS','DUPLICATE_EVIDENCE_HASH','RECENT_REVOCATION_REAPPLY','ORGANISATION_SUSPENDED','CONFLICTING_ACTIVE_ROLES','UNUSUAL_MASS_ACTIVITY','SELF_VERIFICATION_ATTEMPT'))),
  PRIMARY KEY (root_request_id, list, position),
  UNIQUE (root_request_id, list, code)
) STRICT;
CREATE TABLE ver_claims (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  subject_kind                             TEXT NOT NULL CHECK (subject_kind IN ('user','org')),
  subject_id                               TEXT NOT NULL CHECK (length(subject_id) <= 80 AND length(subject_id) > 0),
  claim_type                               TEXT NOT NULL CHECK (claim_type IN ('PERSON_IDENTITY','ORGANISATION_IDENTITY','ORGANISATION_DOMAIN','ORGANISATION_ADMIN','CLUB_AFFILIATION','CLUB_ROLE','LICENCE','AGENCY_AFFILIATION','AGENCY_ROLE','GRASSROOTS_AFFILIATION','FEDERATION_AFFILIATION')),
  organisation_id                          TEXT CHECK (organisation_id IS NULL OR length(organisation_id) <= 80),
  role                                     TEXT CHECK (role IS NULL OR length(role) <= 60),
  status                                   TEXT NOT NULL CHECK (status IN ('unverified','collecting_evidence','pending','automated_checks_passed','requires_human_review','verified','rejected','expired','suspended','revoked','disputed','superseded')),
  valid_from                               INTEGER,
  valid_until                              INTEGER,
  current                                  INTEGER NOT NULL CHECK (current IN (0,1)),
  verification_method                      TEXT CHECK (verification_method IS NULL OR verification_method IN ('official_domain_email','organisation_admin_confirmation','authoritative_registry','federation_confirmation','existing_verified_org_admin','scoutbox_manual_review','document_submitted','reference_confirmation','migration')),
  authority_kind                           TEXT CHECK (authority_kind IS NULL OR authority_kind IN ('org_admin','trust_safety')),
  authority_id                             TEXT CHECK (authority_id IS NULL OR length(authority_id) <= 80),
  created_at                               INTEGER NOT NULL,
  updated_at                               INTEGER NOT NULL,
  verified_at                              INTEGER,
  verified_by_kind                         TEXT CHECK (verified_by_kind IS NULL OR verified_by_kind IN ('system','org_user','org_admin','trust_safety')),
  verified_by_id                           TEXT CHECK (verified_by_id IS NULL OR length(verified_by_id) <= 80),
  revoked_at                               INTEGER,
  revoked_by_kind                          TEXT CHECK (revoked_by_kind IS NULL OR revoked_by_kind IN ('system','org_user','org_admin','trust_safety')),
  revoked_by_id                            TEXT CHECK (revoked_by_id IS NULL OR length(revoked_by_id) <= 80),
  revocation_reason                        TEXT CHECK (revocation_reason IS NULL OR length(revocation_reason) <= 600),
  suspended_at                             INTEGER,
  suspend_reason                           TEXT CHECK (suspend_reason IS NULL OR length(suspend_reason) <= 600),
  disputed_at                              INTEGER,
  expired_at                               INTEGER,
  declared_name                            TEXT CHECK (declared_name IS NULL OR length(declared_name) <= 200),
  pair_id                                  TEXT CHECK (pair_id IS NULL OR length(pair_id) <= 80),
  requested_start                          INTEGER,
  work_email                               TEXT CHECK (work_email IS NULL OR length(work_email) <= 254),
  domain_control                           TEXT CHECK (domain_control IS NULL OR domain_control IN ('passed')),
  domain_covered_by_org                    INTEGER CHECK (domain_covered_by_org IS NULL OR domain_covered_by_org IN (0,1)),
  domain                                   TEXT CHECK (domain IS NULL OR length(domain) <= 253),
  licence_type                             TEXT CHECK (licence_type IS NULL OR length(licence_type) <= 80),
  issuer                                   TEXT CHECK (issuer IS NULL OR length(issuer) <= 80),
  identifier                               TEXT CHECK (identifier IS NULL OR length(identifier) <= 60),
  holder_name                              TEXT CHECK (holder_name IS NULL OR length(holder_name) <= 80),
  display                                  TEXT CHECK (display IS NULL OR length(display) <= 300),
  registry_provider                        TEXT CHECK (registry_provider IS NULL OR length(registry_provider) <= 60),
  registry_state                           TEXT CHECK (registry_state IS NULL OR registry_state IN ('not_configured','temporarily_unavailable','unsupported')),
  registry_result                          TEXT CHECK (registry_result IS NULL OR registry_result IN ('match','no_match','unreadable_record')),
  registry_checked_at                      INTEGER,
  registry_reference                       TEXT CHECK (registry_reference IS NULL OR length(registry_reference) <= 60),
  root_request_id                          TEXT CHECK (root_request_id IS NULL OR length(root_request_id) <= 80),
  org_type                                 TEXT CHECK (org_type IS NULL OR org_type IN ('professional club','academy','grassroots club','federation/association','agency','other approved football organisation')),
  website                                  TEXT CHECK (website IS NULL OR length(website) <= 200),
  admin_level                              TEXT CHECK (admin_level IS NULL OR admin_level IN ('verification_viewer','verification_reviewer','verification_admin','verification_root_admin')),
  identity_link                            TEXT CHECK (identity_link IS NULL OR identity_link IN ('trust_safety_selection','provisioned_new_user','verified_work_email')),
  appointed_reason                         TEXT CHECK (appointed_reason IS NULL OR length(appointed_reason) <= 300),
  via                                      TEXT CHECK (via IS NULL OR length(via) <= 60),
  flagged_at                               INTEGER,
  flagged_reason                           TEXT CHECK (flagged_reason IS NULL OR length(flagged_reason) <= 300),
  migrated_from                            TEXT CHECK (migrated_from IS NULL OR length(migrated_from) <= 200),
  note                                     TEXT CHECK (note IS NULL OR length(note) <= 400),
  representation_id                        TEXT CHECK (representation_id IS NULL OR length(representation_id) <= 80),
  document_reviewed                        TEXT CHECK (document_reviewed IS NULL OR length(document_reviewed) <= 200),
  assigned_to                              TEXT CHECK (assigned_to IS NULL OR length(assigned_to) <= 60),
  expiry_warned_at                         INTEGER,
  FOREIGN KEY (organisation_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (root_request_id) REFERENCES ver_root_requests(id) ON DELETE RESTRICT,
  CHECK (verified_by_kind IS NOT NULL OR verified_by_id IS NULL),
  CHECK (revoked_by_kind IS NOT NULL OR revoked_by_id IS NULL),
  CHECK ((flagged_at IS NULL) = (flagged_reason IS NULL)),
  CHECK (registry_provider IS NOT NULL OR (registry_state IS NULL AND registry_result IS NULL AND registry_checked_at IS NULL AND registry_reference IS NULL))
) STRICT;
CREATE INDEX ver_claims_subject ON ver_claims (subject_kind, subject_id);
CREATE INDEX ver_claims_authority ON ver_claims (authority_id) WHERE authority_kind = 'org_admin';
CREATE INDEX ver_claims_org_subject_status ON ver_claims (organisation_id, subject_kind, status);
CREATE INDEX ver_claims_status ON ver_claims (status, claim_type);
CREATE INDEX ver_claims_valid_until ON ver_claims (valid_until) WHERE status = 'verified';
CREATE INDEX ver_claims_revoked_at ON ver_claims (revoked_at) WHERE status = 'revoked';
CREATE INDEX ver_claims_pair ON ver_claims (pair_id) WHERE pair_id IS NOT NULL;
CREATE UNIQUE INDEX ver_claims_one_identity_per_user ON ver_claims (subject_id) WHERE subject_kind = 'user' AND claim_type = 'PERSON_IDENTITY' AND status IN ('unverified','collecting_evidence','pending','automated_checks_passed','requires_human_review','verified');
CREATE UNIQUE INDEX ver_claims_one_current_affiliation ON ver_claims (subject_id, organisation_id, claim_type) WHERE subject_kind = 'user' AND current = 1 AND claim_type IN ('CLUB_AFFILIATION','CLUB_ROLE','AGENCY_AFFILIATION','AGENCY_ROLE','GRASSROOTS_AFFILIATION') AND status IN ('unverified','collecting_evidence','pending','automated_checks_passed','requires_human_review','verified');
CREATE TABLE ver_claim_codes (
  claim_id  TEXT NOT NULL REFERENCES ver_claims(id) ON DELETE CASCADE,
  list      TEXT NOT NULL CHECK (list IN ('review_reason','risk_flag')),
  position  INTEGER NOT NULL,
  code      TEXT NOT NULL CHECK ((list = 'review_reason' AND code IN ('ROOT_ORGANISATION_BOOTSTRAP','NO_AUTHORITATIVE_SOURCE','CONFLICTING_EVIDENCE','IDENTITY_MISMATCH','DOMAIN_OWNERSHIP_AMBIGUOUS','DUPLICATE_ORGANISATION','HIGH_RISK_ADMIN_CHANGE','DOCUMENT_AUTHENTICITY_UNCONFIRMED','REGISTRY_AMBIGUOUS_MATCH','DISPUTED_CLAIM','SUSPECTED_FRAUD_SIGNALS','MANUAL_EXCEPTION_REQUESTED','REGISTRY_RECORD_UNREADABLE')) OR (list = 'risk_flag' AND code IN ('DISPOSABLE_EMAIL','FREE_EMAIL_PROVIDER','ORG_DOMAIN_MISMATCH','REPEATED_EMAIL_CHALLENGE_FAILURES','COMPETING_ORGANISATION_CLAIMS','CREDENTIAL_REUSED_ACROSS_USERS','DUPLICATE_EVIDENCE_HASH','RECENT_REVOCATION_REAPPLY','ORGANISATION_SUSPENDED','CONFLICTING_ACTIVE_ROLES','UNUSUAL_MASS_ACTIVITY','SELF_VERIFICATION_ATTEMPT'))),
  PRIMARY KEY (claim_id, list, position),
  UNIQUE (claim_id, list, code)
) STRICT;
CREATE TABLE ver_evidence (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  type                                     TEXT NOT NULL CHECK (type IN ('official_email','document','registry_result','organisation_confirmation','federation_confirmation','reference','existing_claim')),
  source                                   TEXT NOT NULL CHECK (length(source) <= 60 AND length(source) > 0),
  supplied_by_kind                         TEXT NOT NULL CHECK (supplied_by_kind IN ('org_user','applicant','system')),
  supplied_by_id                           TEXT CHECK (supplied_by_id IS NULL OR length(supplied_by_id) <= 80),
  org_id                                   TEXT CHECK (org_id IS NULL OR length(org_id) <= 80),
  received_at                              INTEGER NOT NULL,
  media_id                                 TEXT CHECK (media_id IS NULL OR length(media_id) <= 80),
  sha256                                   TEXT CHECK (sha256 IS NULL OR length(sha256) <= 64),
  mime                                     TEXT CHECK (mime IS NULL OR mime IN ('application/pdf','image/png','image/jpeg','image/webp')),
  bytes                                    INTEGER,
  filename                                 TEXT CHECK (filename IS NULL OR length(filename) <= 120),
  note                                     TEXT CHECK (note IS NULL OR length(note) <= 400),
  domain                                   TEXT CHECK (domain IS NULL OR length(domain) <= 253),
  domain_covered_by_org                    INTEGER CHECK (domain_covered_by_org IS NULL OR domain_covered_by_org IN (0,1)),
  address_hash                             TEXT CHECK (address_hash IS NULL OR length(address_hash) <= 64),
  root_request_id                          TEXT CHECK (root_request_id IS NULL OR length(root_request_id) <= 80),
  identifier                               TEXT CHECK (identifier IS NULL OR length(identifier) <= 60),
  licence_type                             TEXT CHECK (licence_type IS NULL OR length(licence_type) <= 80),
  registry_valid_until                     TEXT CHECK (registry_valid_until IS NULL OR length(registry_valid_until) <= 40),
  signing_package_id                       TEXT CHECK (signing_package_id IS NULL OR length(signing_package_id) <= 80),
  signing_document_kind                    TEXT CHECK (signing_document_kind IS NULL OR signing_document_kind IN ('signing','executed')),
  label                                    TEXT CHECK (label IS NULL OR length(label) <= 120),
  check_malware_scan                       TEXT NOT NULL CHECK (check_malware_scan IN ('not_configured')),
  check_content_signature                  TEXT CHECK (check_content_signature IS NULL OR check_content_signature IN ('matched_claimed_type')),
  retention                                TEXT NOT NULL CHECK (retention IN ('until_claim_resolution','until_signing_resolution')),
  visibility                               TEXT NOT NULL CHECK (visibility IN ('trust_and_safety','organisation_internal','subject_only')),
  expires_at                               INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (root_request_id) REFERENCES ver_root_requests(id) ON DELETE RESTRICT,
  CHECK (sha256 IS NULL OR length(sha256) = 64),
  CHECK (bytes IS NULL OR (bytes > 0 AND bytes <= 8388608))
) STRICT;
CREATE INDEX ver_evidence_sha256 ON ver_evidence (sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX ver_evidence_root_request ON ver_evidence (root_request_id) WHERE root_request_id IS NOT NULL;
CREATE TABLE ver_claim_evidence (
  claim_id     TEXT NOT NULL REFERENCES ver_claims(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  evidence_id  TEXT NOT NULL REFERENCES ver_evidence(id) ON DELETE RESTRICT,
  PRIMARY KEY (claim_id, position),
  UNIQUE (claim_id, evidence_id)
) STRICT;
CREATE INDEX ver_claim_evidence_evidence ON ver_claim_evidence (evidence_id);
CREATE TABLE ver_events (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  occurred_at                              INTEGER NOT NULL,
  type                                     TEXT NOT NULL CHECK (type IN ('claim.created','claim.collecting_evidence','claim.pending','claim.automated_checks_passed','claim.requires_human_review','claim.verified','claim.rejected','claim.expired','claim.suspended','claim.revoked','claim.disputed','claim.superseded','claim.unverified','claim.reinstated','claim.corrected','review.requested','review.assigned','review.approved','review.rejected','automated_check.passed','automated_check.failed','evidence.added','evidence.accessed','email.challenge_sent','email.challenge_passed','security.self_verification_blocked','organisation.domain_added','organisation.domain_verified','organisation.domain_removed','admin.invited','admin.accepted','admin.revoked')),
  actor_kind                               TEXT NOT NULL CHECK (actor_kind IN ('org_user','system','trust_safety')),
  actor_id                                 TEXT CHECK (actor_id IS NULL OR length(actor_id) <= 80),
  actor_name                               TEXT CHECK (actor_name IS NULL OR length(actor_name) <= 200),
  actor_org_id                             TEXT CHECK (actor_org_id IS NULL OR length(actor_org_id) <= 80),
  request_id                               TEXT CHECK (request_id IS NULL OR length(request_id) <= 120),
  attribution                              TEXT CHECK (attribution IS NULL OR attribution IN ('authenticated_reviewer','declared_reviewer','shared_admin_key')),
  claim_id                                 TEXT CHECK (claim_id IS NULL OR length(claim_id) <= 80),
  subject_id                               TEXT CHECK (subject_id IS NULL OR length(subject_id) <= 80),
  org_id                                   TEXT CHECK (org_id IS NULL OR length(org_id) <= 80),
  detail                                   TEXT CHECK (detail IS NULL OR length(detail) <= 1000),
  reason                                   TEXT CHECK (reason IS NULL OR length(reason) <= 600),
  FOREIGN KEY (actor_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (claim_id) REFERENCES ver_claims(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ver_events_claim ON ver_events (claim_id) WHERE claim_id IS NOT NULL;
CREATE TABLE ver_tokens (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  token_hash                               TEXT NOT NULL CHECK (length(token_hash) <= 64 AND length(token_hash) > 0),
  purpose                                  TEXT NOT NULL CHECK (purpose IN ('work_email','domain_email','player_invite','root_email')),
  email                                    TEXT CHECK (email IS NULL OR length(email) <= 254),
  subject_kind                             TEXT CHECK (subject_kind IS NULL OR subject_kind IN ('org_user','player')),
  subject_id                               TEXT CHECK (subject_id IS NULL OR length(subject_id) <= 80),
  org_id                                   TEXT CHECK (org_id IS NULL OR length(org_id) <= 80),
  ref_id                                   TEXT CHECK (ref_id IS NULL OR length(ref_id) <= 80),
  created_at                               INTEGER NOT NULL,
  expires_at                               INTEGER NOT NULL,
  used_at                                  INTEGER,
  attempts_failed                          INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  CHECK (length(token_hash) = 64),
  CHECK (attempts_failed >= 0)
) STRICT;
CREATE UNIQUE INDEX ver_tokens_hash ON ver_tokens (token_hash);
CREATE INDEX ver_tokens_subject_purpose ON ver_tokens (subject_id, purpose);
CREATE TABLE ver_admins (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  user_id                                  TEXT NOT NULL CHECK (length(user_id) <= 80 AND length(user_id) > 0),
  level                                    TEXT NOT NULL CHECK (level IN ('verification_viewer','verification_reviewer','verification_admin','verification_root_admin')),
  status                                   TEXT NOT NULL CHECK (status IN ('active','revoked')),
  invited_by                               TEXT NOT NULL CHECK (length(invited_by) <= 80 AND length(invited_by) > 0),
  created_at                               INTEGER NOT NULL,
  accepted_at                              INTEGER,
  revoked_at                               INTEGER,
  revoked_by                               TEXT CHECK (revoked_by IS NULL OR length(revoked_by) <= 80),
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (revoked_by) REFERENCES org_users(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ver_admins_org_user ON ver_admins (org_id, user_id, status);
CREATE UNIQUE INDEX ver_admins_one_active_grant ON ver_admins (org_id, user_id, level) WHERE status = 'active';
CREATE TABLE ver_root_transfers (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  to_user_id                               TEXT NOT NULL CHECK (length(to_user_id) <= 80 AND length(to_user_id) > 0),
  proposed_by                              TEXT NOT NULL CHECK (length(proposed_by) <= 80 AND length(proposed_by) > 0),
  status                                   TEXT NOT NULL CHECK (status IN ('pending','approved')),
  created_at                               INTEGER NOT NULL,
  approved_by                              TEXT CHECK (approved_by IS NULL OR length(approved_by) <= 80),
  approved_at                              INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (to_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (proposed_by) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (approved_by) REFERENCES org_users(id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX ver_root_transfers_one_pending ON ver_root_transfers (org_id) WHERE status = 'pending';
CREATE TABLE ver_disputes (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  claim_id                                 TEXT NOT NULL CHECK (length(claim_id) <= 80 AND length(claim_id) > 0),
  by_kind                                  TEXT NOT NULL CHECK (by_kind IN ('org_user')),
  by_id                                    TEXT NOT NULL CHECK (length(by_id) <= 80 AND length(by_id) > 0),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  reason                                   TEXT NOT NULL CHECK (length(reason) <= 600 AND length(reason) > 0),
  status                                   TEXT NOT NULL CHECK (status IN ('open','resolved')),
  resolution                               TEXT CHECK (resolution IS NULL OR length(resolution) <= 320),
  created_at                               INTEGER NOT NULL,
  resolved_at                              INTEGER,
  resolved_by_name                         TEXT CHECK (resolved_by_name IS NULL OR length(resolved_by_name) <= 200),
  resolved_by_id                           TEXT CHECK (resolved_by_id IS NULL OR length(resolved_by_id) <= 80),
  resolution_attribution                   TEXT CHECK (resolution_attribution IS NULL OR resolution_attribution IN ('authenticated_reviewer','declared_reviewer','shared_admin_key')),
  FOREIGN KEY (claim_id) REFERENCES ver_claims(id) ON DELETE RESTRICT,
  FOREIGN KEY (by_id) REFERENCES org_users(id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX ver_disputes_one_open_per_claim ON ver_disputes (claim_id) WHERE status = 'open';
CREATE INDEX ver_disputes_status ON ver_disputes (status);
CREATE TABLE ver_references (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  version                                  INTEGER NOT NULL,
  supersedes_id                            TEXT CHECK (supersedes_id IS NULL OR length(supersedes_id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  player_name                              TEXT CHECK (player_name IS NULL OR length(player_name) <= 200),
  coach_user_id                            TEXT NOT NULL CHECK (length(coach_user_id) <= 80 AND length(coach_user_id) > 0),
  coach_name                               TEXT CHECK (coach_name IS NULL OR length(coach_name) <= 200),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  org_name                                 TEXT CHECK (org_name IS NULL OR length(org_name) <= 200),
  role_at_time                             TEXT CHECK (role_at_time IS NULL OR length(role_at_time) <= 200),
  provenance_claim_id                      TEXT NOT NULL CHECK (length(provenance_claim_id) <= 80 AND length(provenance_claim_id) > 0),
  provenance_claim_type                    TEXT NOT NULL CHECK (provenance_claim_type IN ('PERSON_IDENTITY','ORGANISATION_IDENTITY','ORGANISATION_DOMAIN','ORGANISATION_ADMIN','CLUB_AFFILIATION','CLUB_ROLE','LICENCE','AGENCY_AFFILIATION','AGENCY_ROLE','GRASSROOTS_AFFILIATION','FEDERATION_AFFILIATION')),
  provenance_status                        TEXT NOT NULL CHECK (provenance_status IN ('verified')),
  provenance_method                        TEXT CHECK (provenance_method IS NULL OR provenance_method IN ('official_domain_email','organisation_admin_confirmation','authoritative_registry','federation_confirmation','existing_verified_org_admin','scoutbox_manual_review','document_submitted','reference_confirmation','migration')),
  provenance_verified_at                   INTEGER,
  provenance_snapshot_at                   INTEGER NOT NULL,
  relationship                             TEXT NOT NULL CHECK (length(relationship) <= 80 AND length(relationship) > 0),
  capacity                                 TEXT NOT NULL CHECK (length(capacity) <= 120),
  from_year                                INTEGER,
  to_year                                  INTEGER,
  strengths                                TEXT NOT NULL CHECK (length(strengths) <= 500),
  development                              TEXT NOT NULL CHECK (length(development) <= 500),
  summary                                  TEXT NOT NULL CHECK (length(summary) <= 800 AND length(summary) > 0),
  status                                   TEXT NOT NULL CHECK (status IN ('active','withdrawn','superseded')),
  withdrawn_at                             INTEGER,
  withdraw_reason                          TEXT CHECK (withdraw_reason IS NULL OR length(withdraw_reason) <= 300),
  created_at                               INTEGER NOT NULL,
  FOREIGN KEY (supersedes_id) REFERENCES ver_references(id) ON DELETE RESTRICT,
  FOREIGN KEY (coach_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (provenance_claim_id) REFERENCES ver_claims(id) ON DELETE RESTRICT,
  CHECK (version >= 1)
) STRICT;
CREATE INDEX ver_references_player ON ver_references (player_id, status);
CREATE INDEX ver_references_org ON ver_references (org_id);
CREATE TABLE ver_player_invites (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  by_user_id                               TEXT NOT NULL CHECK (length(by_user_id) <= 80 AND length(by_user_id) > 0),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  invitee_name                             TEXT NOT NULL CHECK (length(invitee_name) <= 80 AND length(invitee_name) > 0),
  squad                                    TEXT NOT NULL CHECK (length(squad) <= 60),
  status                                   TEXT NOT NULL CHECK (status IN ('pending','accepted')),
  player_id                                TEXT CHECK (player_id IS NULL OR length(player_id) <= 80),
  target_player_id                         TEXT CHECK (target_player_id IS NULL OR length(target_player_id) <= 80),
  guardian_approved_id                     TEXT CHECK (guardian_approved_id IS NULL OR length(guardian_approved_id) <= 80 AND length(guardian_approved_id) > 0),
  guardian_approved_at                     INTEGER,
  created_at                               INTEGER NOT NULL,
  expires_at                               INTEGER NOT NULL,
  accepted_at                              INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK ((status = 'accepted') = (player_id IS NOT NULL AND accepted_at IS NOT NULL))
) STRICT;
CREATE INDEX ver_player_invites_org_created ON ver_player_invites (org_id, created_at);
CREATE INDEX ver_player_invites_player ON ver_player_invites (player_id, status);
CREATE TABLE ver_conflicts (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  user_id                                  TEXT NOT NULL CHECK (length(user_id) <= 80 AND length(user_id) > 0),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  kind                                     TEXT NOT NULL CHECK (kind IN ('family_relationship','agent_relationship','financial_interest','coaching_relationship','other')),
  subject                                  TEXT NOT NULL CHECK (length(subject) <= 120),
  note                                     TEXT NOT NULL CHECK (length(note) <= 400),
  created_at                               INTEGER NOT NULL,
  withdrawn_at                             INTEGER,
  FOREIGN KEY (user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ver_conflicts_org_user ON ver_conflicts (org_id, user_id);
CREATE INDEX ver_conflicts_user ON ver_conflicts (user_id, withdrawn_at);
CREATE TABLE ver_domain_requests (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  domain                                   TEXT NOT NULL CHECK (length(domain) <= 253 AND length(domain) > 0),
  requested_by                             TEXT NOT NULL CHECK (length(requested_by) <= 80 AND length(requested_by) > 0),
  status                                   TEXT NOT NULL CHECK (status IN ('email_challenge','requires_human_review','verified','rejected')),
  method                                   TEXT CHECK (method IS NULL OR method IN ('official_domain_email','scoutbox_manual_review')),
  created_at                               INTEGER NOT NULL,
  decided_at                               INTEGER,
  decided_by_name                          TEXT CHECK (decided_by_name IS NULL OR length(decided_by_name) <= 200),
  decided_by_id                            TEXT CHECK (decided_by_id IS NULL OR length(decided_by_id) <= 80),
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (requested_by) REFERENCES org_users(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ver_domain_requests_org ON ver_domain_requests (org_id);
CREATE INDEX ver_domain_requests_status ON ver_domain_requests (status);
CREATE TABLE ver_domain_request_codes (
  domain_request_id  TEXT NOT NULL REFERENCES ver_domain_requests(id) ON DELETE CASCADE,
  list      TEXT NOT NULL CHECK (list IN ('review_reason')),
  position  INTEGER NOT NULL,
  code      TEXT NOT NULL CHECK ((list = 'review_reason' AND code IN ('ROOT_ORGANISATION_BOOTSTRAP','NO_AUTHORITATIVE_SOURCE','CONFLICTING_EVIDENCE','IDENTITY_MISMATCH','DOMAIN_OWNERSHIP_AMBIGUOUS','DUPLICATE_ORGANISATION','HIGH_RISK_ADMIN_CHANGE','DOCUMENT_AUTHENTICITY_UNCONFIRMED','REGISTRY_AMBIGUOUS_MATCH','DISPUTED_CLAIM','SUSPECTED_FRAUD_SIGNALS','MANUAL_EXCEPTION_REQUESTED','REGISTRY_RECORD_UNREADABLE'))),
  PRIMARY KEY (domain_request_id, list, position),
  UNIQUE (domain_request_id, list, code)
) STRICT;
CREATE TABLE org_verified_domains (
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  domain                                   TEXT NOT NULL CHECK (length(domain) <= 253 AND length(domain) > 0),
  status                                   TEXT NOT NULL CHECK (status IN ('verified')),
  method                                   TEXT NOT NULL CHECK (method IN ('official_domain_email','scoutbox_manual_review')),
  verified_at                              INTEGER NOT NULL,
  added_by                                 TEXT NOT NULL CHECK (length(added_by) <= 80 AND length(added_by) > 0),
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  PRIMARY KEY (org_id, domain)
) STRICT;
CREATE INDEX org_verified_domains_domain ON org_verified_domains (domain);
CREATE TABLE ver_migrations (
  key            TEXT PRIMARY KEY CHECK (key IN ('m14')),
  ran_at         INTEGER NOT NULL,
  claims_created INTEGER NOT NULL CHECK (claims_created >= 0)
) STRICT;


-- =============================================================================
-- M15 — Football Passport
-- =============================================================================

-- ----------------------------------------------------------------------------
-- S10b: IMPLEMENTED, migration 0024_passport REGISTERED (repositories/passport.mjs, 4 Nov 2026).
-- The definitions below are the migration's DDL (generated from the repository's field specs, like S10a);
-- scripts/testSchemaDdl.mjs compares them column by column.
-- Sources: domains/verification/passport/ (passport.mjs, sharing.mjs).
-- How the model differs from the first draft of this file:
--   * No JSON columns. Football dates (career from/to, achievement when, position history from, available from) are
--     TEXT 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD': the precision the player gave, never an invented day. The routes write
--     any accepted input (an epoch, {year, month}) in that shape.
--   * Positions are PLAYER_POSITIONS codes. Secondary positions (≤3) are ordered rows: passport_pref_positions and
--     passport_position_history_positions. Public selections are ordered rows without repeats.
--   * A preferences row exists only once a player or guardian saved (no insert on read).
--   * Player and guardian ids carry no key (tolerant, as S9 and S10a); a confirmation's organisation is RESTRICT.
--   * A correction's resolution instant is one column (resolved_at), read back as both resolution.at and resolvedAt.
-- ----------------------------------------------------------------------------
CREATE TABLE passport_prefs (
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  bio                                      TEXT CHECK (bio IS NULL OR length(bio) <= 400),
  position_primary                         TEXT CHECK (position_primary IS NULL OR position_primary IN ('GK','CB','RB','LB','RWB','LWB','CDM','CM','CAM','RW','LW','ST','CF')),
  availability                             TEXT CHECK (availability IS NULL OR availability IN ('open_to_trials','open_to_contact','not_looking')),
  available_from                           TEXT CHECK (available_from IS NULL OR (available_from GLOB '[0-9][0-9][0-9][0-9]' OR available_from GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' OR available_from GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')),
  updated_at                               INTEGER NOT NULL,
  PRIMARY KEY (player_id)
) STRICT;
CREATE TABLE passport_pref_positions (
  player_id  TEXT NOT NULL REFERENCES passport_prefs(player_id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL CHECK (ord >= 0),
  code    TEXT NOT NULL CHECK (code IN ('GK','CB','RB','LB','RWB','LWB','CDM','CM','CAM','RW','LW','ST','CF') AND ord < 3),
  PRIMARY KEY (player_id, ord),
  UNIQUE (player_id, code)
) STRICT;
CREATE TABLE passport_position_history (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  from_date                                TEXT NOT NULL CHECK ((from_date GLOB '[0-9][0-9][0-9][0-9]' OR from_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' OR from_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')),
  position_primary                         TEXT NOT NULL CHECK (position_primary IN ('GK','CB','RB','LB','RWB','LWB','CDM','CM','CAM','RW','LW','ST','CF')),
  submitted_by                             TEXT NOT NULL CHECK (submitted_by IN ('player','guardian')),
  recorded_at                              INTEGER NOT NULL,
  FOREIGN KEY (player_id) REFERENCES passport_prefs(player_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX passport_position_history_player ON passport_position_history (player_id);
CREATE TABLE passport_position_history_positions (
  history_id  TEXT NOT NULL REFERENCES passport_position_history(id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL CHECK (ord >= 0),
  code    TEXT NOT NULL CHECK (code IN ('GK','CB','RB','LB','RWB','LWB','CDM','CM','CAM','RW','LW','ST','CF') AND ord < 3),
  PRIMARY KEY (history_id, ord),
  UNIQUE (history_id, code)
) STRICT;
CREATE TABLE passport_public_selections (
  player_id  TEXT NOT NULL REFERENCES passport_prefs(player_id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL CHECK (ord >= 0),
  selection    TEXT NOT NULL CHECK (length(selection) > 0 AND length(selection) <= 120 AND ord < 100),
  PRIMARY KEY (player_id, ord),
  UNIQUE (player_id, selection)
) STRICT;
CREATE TABLE passport_career_entries (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  org_name                                 TEXT NOT NULL CHECK (length(org_name) <= 100 AND length(org_name) > 0),
  role                                     TEXT CHECK (role IS NULL OR length(role) <= 60),
  from_date                                TEXT NOT NULL CHECK ((from_date GLOB '[0-9][0-9][0-9][0-9]' OR from_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' OR from_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')),
  to_date                                  TEXT CHECK (to_date IS NULL OR (to_date GLOB '[0-9][0-9][0-9][0-9]' OR to_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' OR to_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')),
  note                                     TEXT CHECK (note IS NULL OR length(note) <= 200),
  submitted_by                             TEXT NOT NULL CHECK (submitted_by IN ('player','guardian')),
  created_at                               INTEGER NOT NULL,
  withdrawn_at                             INTEGER
) STRICT;
CREATE INDEX passport_career_entries_player ON passport_career_entries (player_id);
CREATE TABLE passport_achievements (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  title                                    TEXT NOT NULL CHECK (length(title) <= 120 AND length(title) > 0),
  org_name                                 TEXT CHECK (org_name IS NULL OR length(org_name) <= 100),
  when_date                                TEXT CHECK (when_date IS NULL OR (when_date GLOB '[0-9][0-9][0-9][0-9]' OR when_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' OR when_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')),
  submitted_by                             TEXT NOT NULL CHECK (submitted_by IN ('player','guardian')),
  confirmation_provenance                  TEXT CHECK (confirmation_provenance IS NULL OR confirmation_provenance IN ('verified_club_confirmed')),
  confirmation_org_id                      TEXT CHECK (confirmation_org_id IS NULL OR length(confirmation_org_id) <= 80 AND length(confirmation_org_id) > 0),
  confirmation_org_name                    TEXT CHECK (confirmation_org_name IS NULL OR length(confirmation_org_name) <= 200),
  confirmation_by_name                     TEXT CHECK (confirmation_by_name IS NULL OR length(confirmation_by_name) <= 200),
  confirmation_at                          INTEGER,
  created_at                               INTEGER NOT NULL,
  withdrawn_at                             INTEGER,
  FOREIGN KEY (confirmation_org_id) REFERENCES orgs(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX passport_achievements_player ON passport_achievements (player_id);
CREATE TABLE passport_shares (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  mode                                     TEXT NOT NULL CHECK (mode IN ('public','recruitment')),
  token_hash                               TEXT NOT NULL CHECK (length(token_hash) <= 64 AND length(token_hash) > 0),
  created_by_kind                          TEXT NOT NULL CHECK (created_by_kind IN ('player','guardian')),
  created_by_id                            TEXT NOT NULL CHECK (length(created_by_id) <= 80 AND length(created_by_id) > 0),
  created_at                               INTEGER NOT NULL,
  expires_at                               INTEGER NOT NULL,
  revoked_at                               INTEGER,
  revoked_by_kind                          TEXT CHECK (revoked_by_kind IS NULL OR revoked_by_kind IN ('player','guardian','trust_safety')),
  revoked_by_id                            TEXT CHECK (revoked_by_id IS NULL OR length(revoked_by_id) <= 80 AND length(revoked_by_id) > 0),
  views                                    INTEGER NOT NULL DEFAULT 0,
  CHECK (length(token_hash) = 64),
  CHECK (views >= 0),
  CHECK ((revoked_at IS NULL) = (revoked_by_kind IS NULL))
) STRICT;
CREATE UNIQUE INDEX passport_shares_token_hash ON passport_shares (token_hash);
CREATE INDEX passport_shares_player ON passport_shares (player_id);
CREATE TABLE passport_corrections (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  target_kind                              TEXT NOT NULL CHECK (target_kind IN ('timeline_event','career_entry','club_history','reference','trial','assessment','achievement','signing')),
  target_id                                TEXT CHECK (target_id IS NULL OR length(target_id) <= 80),
  reason                                   TEXT NOT NULL CHECK (length(reason) <= 500 AND length(reason) > 0),
  by_kind                                  TEXT NOT NULL CHECK (by_kind IN ('player','guardian')),
  by_id                                    TEXT NOT NULL CHECK (length(by_id) <= 80 AND length(by_id) > 0),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  status                                   TEXT NOT NULL CHECK (status IN ('open','resolved')),
  resolution_outcome                       TEXT CHECK (resolution_outcome IS NULL OR resolution_outcome IN ('corrected','rejected','referred')),
  resolution_reason                        TEXT CHECK (resolution_reason IS NULL OR length(resolution_reason) <= 400 AND length(resolution_reason) > 0),
  resolved_at                              INTEGER,
  created_at                               INTEGER NOT NULL,
  CHECK ((status = 'resolved') = (resolution_outcome IS NOT NULL))
) STRICT;
CREATE INDEX passport_corrections_status ON passport_corrections (status);
CREATE INDEX passport_corrections_player ON passport_corrections (player_id);


-- =============================================================================
-- M13 F2 transition cases and core coach references (vouches)
-- =============================================================================

-- ----------------------------------------------------------------------------
-- S10c: IMPLEMENTED, migration 0025_transitions_vouches REGISTERED (repositories/transitionsVouches.mjs, 5 Nov 2026).
-- The definitions below are the migration's DDL (generated from the repository's field specs, like S10a and S10b);
-- scripts/testSchemaDdl.mjs compares them column by column.
-- Sources: domains/verification/transitions.mjs (transition cases); server.mjs (reference request, /vouch/submit,
-- the club release reference, the T&S list and revoke) and domains/scouting/passport.mjs (the T&S withdrawal).
-- How the model differs from the first draft of this file:
--   * No JSON columns. A history entry's detail is one of two typed columns, by action: detail_items (opened) or
--     detail_org_id (a grant, a revocation, a placement); none for a withdrawal or an expiry.
--   * A grant (transition_case_recipients) is keyed by its position in the case (ord), not (org, granted_at); its
--     organisation is RESTRICT, as is a placement's. Pack items keep their order (ord).
--   * follow_up_completed_at is dropped (no route ever set it); the follow-up is its due and notified instants.
--   * caseOwner is not stored (always startedBy); vouches.verificationMethod / identityVerified are not stored (always
--     'email_code' and false: an email code proves the mailbox, never the person).
--   * A reference code is stored as its SHA-256 hash (code_hash), held exactly while the reference is pending
--     (single use) and unique; the plain code exists only in the coach's email.
--   * Player and guardian ids carry no key (tolerant, as S9, S10a and S10b): a case or a reference outlives an
--     account deletion under the old id, as before (retention, decisions.md Q6).
-- Read patterns: transition_cases by player (player and guardian lists); open cases with a live grant for an
--   organisation (club list, EXISTS over transition_case_recipients_org); the sweep by (status, period_ends_at) and
--   the due follow-ups (partial index). vouches by (player_id, status) [every profile]; by code_hash while pending
--   [submit]; by id [T&S revoke and withdraw]; newest first by rowid [the T&S list, paged by cursor].
-- ----------------------------------------------------------------------------
CREATE TABLE transition_cases (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  player_name                              TEXT CHECK (player_name IS NULL OR length(player_name) <= 200),
  started_by_kind                          TEXT NOT NULL CHECK (started_by_kind IN ('player','guardian')),
  started_by_id                            TEXT NOT NULL CHECK (length(started_by_id) <= 80 AND length(started_by_id) > 0),
  started_by_name                          TEXT CHECK (started_by_name IS NULL OR length(started_by_name) <= 200),
  note                                     TEXT CHECK (note IS NULL OR length(note) <= 500),
  period_ends_at                           INTEGER NOT NULL,
  status                                   TEXT NOT NULL CHECK (status IN ('open','withdrawn','placed','expired')),
  placement_org_id                         TEXT CHECK (placement_org_id IS NULL OR length(placement_org_id) <= 80 AND length(placement_org_id) > 0),
  placement_org_name                       TEXT CHECK (placement_org_name IS NULL OR length(placement_org_name) <= 200),
  placement_at                             INTEGER,
  placement_note                           TEXT CHECK (placement_note IS NULL OR length(placement_note) <= 300),
  follow_up_due_at                         INTEGER,
  follow_up_notified_at                    INTEGER,
  created_at                               INTEGER NOT NULL,
  FOREIGN KEY (placement_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  CHECK ((status = 'placed') = (placement_org_id IS NOT NULL)),
  CHECK (follow_up_due_at IS NULL OR placement_org_id IS NOT NULL)
) STRICT;
CREATE INDEX transition_cases_player ON transition_cases (player_id);
CREATE INDEX transition_cases_status_period ON transition_cases (status, period_ends_at);
CREATE INDEX transition_cases_follow_up ON transition_cases (follow_up_due_at) WHERE follow_up_due_at IS NOT NULL AND follow_up_notified_at IS NULL;
CREATE TABLE transition_case_pack_items (
  transition_case_id TEXT NOT NULL REFERENCES transition_cases(id) ON DELETE CASCADE,
  item_kind         TEXT NOT NULL CHECK (item_kind IN ('media','evidence','feedback')),
  ord                INTEGER NOT NULL CHECK (ord >= 0 AND ord < 100),
  item_id            TEXT NOT NULL CHECK (length(item_id) > 0 AND length(item_id) <= 80),
  PRIMARY KEY (transition_case_id, item_kind, item_id),
  UNIQUE (transition_case_id, item_kind, ord)
) STRICT;
CREATE TABLE transition_case_recipients (
  transition_case_id                       TEXT NOT NULL CHECK (length(transition_case_id) <= 80 AND length(transition_case_id) > 0),
  ord                                      INTEGER NOT NULL,
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  org_name                                 TEXT CHECK (org_name IS NULL OR length(org_name) <= 200),
  granted_at                               INTEGER NOT NULL,
  expires_at                               INTEGER NOT NULL,
  revoked_at                               INTEGER,
  viewed_at                                INTEGER,
  FOREIGN KEY (transition_case_id) REFERENCES transition_cases(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  PRIMARY KEY (transition_case_id, ord),
  CHECK (ord >= 0),
  CHECK (expires_at >= granted_at)
) STRICT;
CREATE INDEX transition_case_recipients_org ON transition_case_recipients (org_id, revoked_at, expires_at);
CREATE TABLE transition_case_history (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  transition_case_id                       TEXT NOT NULL CHECK (length(transition_case_id) <= 80 AND length(transition_case_id) > 0),
  at                                       INTEGER NOT NULL,
  by_kind                                  TEXT NOT NULL CHECK (by_kind IN ('player','guardian','system')),
  by_id                                    TEXT NOT NULL CHECK (length(by_id) <= 80 AND length(by_id) > 0),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  action                                   TEXT NOT NULL CHECK (action IN ('opened','recipient_added','recipient_revoked','withdrawn','placed','expired')),
  detail_items                             INTEGER,
  detail_org_id                            TEXT CHECK (detail_org_id IS NULL OR length(detail_org_id) <= 80 AND length(detail_org_id) > 0),
  FOREIGN KEY (transition_case_id) REFERENCES transition_cases(id) ON DELETE CASCADE,
  CHECK (detail_items IS NULL OR detail_items > 0),
  CHECK ((action = 'opened') = (detail_items IS NOT NULL)),
  CHECK ((action IN ('recipient_added','recipient_revoked','placed')) = (detail_org_id IS NOT NULL))
) STRICT;
CREATE INDEX transition_case_history_case ON transition_case_history (transition_case_id);
CREATE TABLE vouches (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  player_name                              TEXT CHECK (player_name IS NULL OR length(player_name) <= 200),
  coach_name                               TEXT NOT NULL CHECK (length(coach_name) <= 100 AND length(coach_name) > 0),
  coach_email                              TEXT CHECK (coach_email IS NULL OR length(coach_email) <= 254),
  role                                     TEXT NOT NULL CHECK (length(role) <= 200 AND length(role) > 0),
  status                                   TEXT NOT NULL CHECK (status IN ('pending','published','revoked')),
  code_hash                                TEXT CHECK (code_hash IS NULL OR length(code_hash) <= 64),
  text                                     TEXT CHECK (text IS NULL OR length(text) <= 400),
  seasons                                  TEXT CHECK (seasons IS NULL OR length(seasons) <= 40),
  created_at                               INTEGER NOT NULL,
  published_at                             INTEGER,
  conflict_of_interest                     TEXT CHECK (conflict_of_interest IS NULL OR length(conflict_of_interest) <= 200),
  withdrawn_at                             INTEGER,
  withdrawn_by                             TEXT CHECK (withdrawn_by IS NULL OR withdrawn_by IN ('admin')),
  withdrawn_reason                         TEXT CHECK (withdrawn_reason IS NULL OR length(withdrawn_reason) <= 200 AND length(withdrawn_reason) > 0),
  CHECK (length(code_hash) = 64),
  CHECK ((status = 'pending') = (code_hash IS NOT NULL)),
  CHECK (status <> 'published' OR (text IS NOT NULL AND published_at IS NOT NULL))
) STRICT;
CREATE INDEX vouches_player_status ON vouches (player_id, status);
CREATE UNIQUE INDEX vouches_code_hash ON vouches (code_hash) WHERE code_hash IS NOT NULL;
