-- 0023_verification: verification claims, events, evidence, tokens, administrators, root transfers and applications, disputes, references, squad invitations, conflicts, domain requests and verified domains become typed tables

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
  CHECK (registry_provider IS NOT NULL OR (registry_state IS NULL AND registry_result IS NULL AND registry_checked_at IS NULL AND registry_reference IS NULL)),
  CHECK (registry_provider IS NULL OR registry_checked_at IS NOT NULL)
) STRICT;
CREATE INDEX ver_claims_subject ON ver_claims (subject_kind, subject_id);
CREATE INDEX ver_claims_authority ON ver_claims (authority_id) WHERE authority_kind = 'org_admin';
CREATE INDEX ver_claims_org_subject_status ON ver_claims (organisation_id, subject_kind, status);
CREATE INDEX ver_claims_status ON ver_claims (status, claim_type);
CREATE INDEX ver_claims_valid_until ON ver_claims (valid_until) WHERE status = 'verified';
CREATE INDEX ver_claims_revoked_at ON ver_claims (revoked_at) WHERE status = 'revoked';
CREATE UNIQUE INDEX ver_claims_subject_org_key ON ver_claims (id, subject_id, organisation_id);
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
  FOREIGN KEY (supersedes_id, player_id, coach_user_id, org_id) REFERENCES ver_references(id, player_id, coach_user_id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (coach_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (provenance_claim_id, coach_user_id, org_id) REFERENCES ver_claims(id, subject_id, organisation_id) ON DELETE RESTRICT,
  CHECK (version >= 1),
  CHECK ((supersedes_id IS NULL) = (version = 1))
) STRICT;
CREATE UNIQUE INDEX ver_references_chain_key ON ver_references (id, player_id, coach_user_id, org_id);
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
  CHECK ((status = 'accepted') = (player_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK ((guardian_approved_id IS NULL) = (guardian_approved_at IS NULL))
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
