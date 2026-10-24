-- =============================================================================
-- 05_verification_passport.sql — ScoutBox target relational schema
-- Scope: M14 Verification & Trust (verClaims, verEvents, verEvidence,
--        verTokens, verAdmins, verRootRequests, verRootTransfers, verDisputes,
--        verReferences, verPlayerInvites, verConflicts, verDomainRequests,
--        verMigrated, orgs[].verification.domains[]), M15 Football Passport
--        (passportPrefs, passportCareerEntries, passportAchievements,
--        passportShares, passportCorrections), M13 F2 transitionCases,
--        M13 F10 representations (legacy, creation closed) and core vouches.
-- Depends on: 01_identity.sql (orgs, org_users, players, guardians) and
--             02_recruitment.sql (evidence, assessments).
-- Conventions: docs/architecture/sql conventions (STRICT tables, snake_case,
--   epoch-ms INTEGER *_at, hashed secrets, *_json only with a stated reason).
-- JSON policy for this file:
--   * review_reasons_json / risk_flags_json — bounded arrays of reason/flag
--     CODES (REVIEW_REASONS + 'REGISTRY_RECORD_UNREADABLE'; riskFlags()
--     output). Read whole with .includes(), never queried by element.
--     Deferred normalisation: a child table the day a queue filter by code is
--     needed.
--   * metadata_json (ver_claims) — free-form by design: the key set depends on
--     claimType (licence fields, registry result, root-request link, migration
--     provenance...). Lookup keys (pairId, workEmail, assignedTo, expiryWarned)
--     are promoted to columns.
--   * meta_json / declarations_json (evidence, root requests) — free-form by
--     design: supplied by the caller (note, address hash, signing package
--     link...) and echoed back verbatim.
--   * before_json / after_json / detail_json — audit payloads, free-form by
--     design (every event type carries a different shape).
--   * *_raw_json (passport dates) — the client's raw value: an epoch number,
--     'YYYY' / 'YYYY-MM' / 'YYYY-MM-DD' string or {year,month} object.
--     Precision belongs to the source (normWhen() at read); normalising would
--     invent days the player never gave.
--   * position_secondary_json — ≤3 position codes; NULL means "positions not
--     set" (the whole positions object was null), '[]' means set with none.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- source: db.verClaims  created at m14/index.mjs:56 (createClaim) and
--         m14/shared.mjs:507 (mkClaim, migrated rows vclm-m-N)
-- owner/writer: m14 (organisations.mjs, review.mjs, shared.mjs applyTransition)
-- lifecycle: status unverified → collecting_evidence → pending →
--   automated_checks_passed | requires_human_review → verified | rejected;
--   verified → expired | suspended | revoked | disputed | superseded;
--   VALID_TRANSITIONS in m14/shared.mjs:61. No deletes. `current=0` closes a
--   verified period (departed / mark_former) without erasing it.
-- mapping:
--   id -> id (vclm-N; vclm-m-N for M14 migration rows)
--   subjectType -> subject_kind ('user' | 'org')
--   subjectId -> subject_id (org_users.id when subject_kind='user', orgs.id
--     when 'org'; polymorphic, no FK)
--   claimType -> claim_type
--   organisationId -> organisation_id
--   role -> role (≤60)
--   status -> status
--   validFrom -> valid_from   validUntil -> valid_until (EXCLUSIVE expiry ms;
--     NULL = no expiry; m14/shared.mjs:124)
--   current -> current
--   verificationMethod -> verification_method
--   authorityType -> authority_kind   authorityId -> authority_id (org_users.id
--     for org_admin, literal 'admin' for trust_safety; no FK)
--   evidenceIds[] -> ver_claim_evidence (junction, see ver_evidence)
--   createdAt -> created_at   updatedAt -> updated_at   verifiedAt -> verified_at
--   verifiedBy{kind,id} -> verified_by_kind, verified_by_id
--   revokedAt -> revoked_at   revokedBy{kind,id} -> revoked_by_kind, revoked_by_id
--   revocationReason -> revocation_reason
--   suspendedAt -> suspended_at   suspendReason -> suspend_reason
--   disputedAt -> disputed_at   expiredAt -> expired_at
--   supersedesClaimId -> dead field, not migrated (initialised null at
--     index.mjs:65 / shared.mjs:511, never assigned anywhere)
--   reviewReasons[] -> review_reasons_json
--   riskFlags[] -> risk_flags_json
--   metadata.pairId -> pair_id (vpair-N; links affiliation+role claims)
--   metadata.workEmail -> work_email  (plaintext today; organisations.mjs:269)
--   metadata.assignedTo -> assigned_to (review.mjs:281)
--   metadata.expiryWarned -> expiry_warned_at (review.mjs:654)
--   metadata.<everything else> -> metadata_json (declaredName, requestedStart,
--     domainControl, domainCoveredByOrg, domain, licenceType, issuer,
--     identifier, holderName, issueDate, expiry, display, registry{}, rootRequest,
--     orgType, website, level, identityLink, appointedReason, via,
--     flaggedForReview{at,reason}, migratedFrom, note, representationId,
--     documentReviewed)
--   history[] -> ver_claim_history (migration rows only; see that table)
-- notes:
--   * Uniqueness enforced by code today (409 IDENTITY_CLAIM_EXISTS /
--     AFFILIATION_CLAIM_EXISTS): one PERSON_IDENTITY per user in an open or
--     verified state; one current affiliation/role claim per (user, org,
--     claim_type) in an open or verified state. Both expressed below as
--     partial unique indexes.
--   * Self-verification forbidden (authority_id ≠ subject_id) — code rule,
--     not a constraint (authority is set after the fact).
--   * Privacy: work_email is personal data; metadata_json may hold licence
--     identifiers and holder names; never public (toPublicVerificationProfile
--     is the only projector).
--   * Read patterns: by (subject_kind, subject_id) [claim index]; by
--     authority_id where authority_kind='org_admin' [cascade]; by
--     (organisation_id, subject_kind, status) [console]; global by status
--     [T&S queue]; verified with valid_until in next 30d [sweep/queue];
--     revoked in last 14d [queue]; by pair_id [decide]; by claim_type [queue].
-- -----------------------------------------------------------------------------
CREATE TABLE ver_claims (
  id                  TEXT PRIMARY KEY,
  subject_kind        TEXT NOT NULL CHECK (subject_kind IN ('user','org')),
  subject_id          TEXT NOT NULL,                       -- org_users.id | orgs.id (polymorphic, no FK)
  claim_type          TEXT NOT NULL CHECK (claim_type IN (
                        'PERSON_IDENTITY','ORGANISATION_IDENTITY','ORGANISATION_DOMAIN',
                        'ORGANISATION_ADMIN','CLUB_AFFILIATION','CLUB_ROLE','LICENCE',
                        'AGENCY_AFFILIATION','AGENCY_ROLE','GRASSROOTS_AFFILIATION',
                        'FEDERATION_AFFILIATION')),
  organisation_id     TEXT REFERENCES orgs(id) ON DELETE RESTRICT,
  role                TEXT CHECK (role IS NULL OR length(role) <= 60),
  status              TEXT NOT NULL CHECK (status IN (
                        'unverified','collecting_evidence','pending','automated_checks_passed',
                        'requires_human_review','verified','rejected','expired','suspended',
                        'revoked','disputed','superseded')),
  valid_from          INTEGER,
  valid_until         INTEGER,                             -- exclusive expiry instant
  current             INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0,1)),
  verification_method TEXT CHECK (verification_method IS NULL OR verification_method IN (
                        'official_domain_email','organisation_admin_confirmation',
                        'authoritative_registry','federation_confirmation',
                        'existing_verified_org_admin','scoutbox_manual_review',
                        'document_submitted','reference_confirmation','migration')),
  authority_kind      TEXT CHECK (authority_kind IS NULL OR authority_kind IN ('org_admin','trust_safety')),
  authority_id        TEXT,                                -- org_users.id | 'admin' (no FK)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  verified_at         INTEGER,
  verified_by_kind    TEXT CHECK (verified_by_kind IS NULL OR verified_by_kind IN ('system','org_user','org_admin','trust_safety')),
  verified_by_id      TEXT,                                -- org_users.id | reviewer id | 'admin' | NULL
  revoked_at          INTEGER,
  revoked_by_kind     TEXT CHECK (revoked_by_kind IS NULL OR revoked_by_kind IN ('system','org_user','trust_safety')),
  revoked_by_id       TEXT,
  revocation_reason   TEXT,
  suspended_at        INTEGER,
  suspend_reason      TEXT,
  disputed_at         INTEGER,
  expired_at          INTEGER,
  review_reasons_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(review_reasons_json) AND json_type(review_reasons_json) = 'array'),
  risk_flags_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(risk_flags_json) AND json_type(risk_flags_json) = 'array'),
  pair_id             TEXT,                                -- vpair-N, shared by the affiliation+role pair
  work_email          TEXT,                                -- personal data (lower-cased, plaintext today)
  assigned_to         TEXT CHECK (assigned_to IS NULL OR length(assigned_to) <= 60),
  expiry_warned_at    INTEGER,
  metadata_json       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object')
) STRICT;

CREATE INDEX ver_claims_subject ON ver_claims(subject_kind, subject_id);
CREATE INDEX ver_claims_authority ON ver_claims(authority_id) WHERE authority_kind = 'org_admin';
CREATE INDEX ver_claims_org_subject_status ON ver_claims(organisation_id, subject_kind, status);
CREATE INDEX ver_claims_status ON ver_claims(status);
CREATE INDEX ver_claims_claim_type_status ON ver_claims(claim_type, status);
CREATE INDEX ver_claims_valid_until ON ver_claims(valid_until) WHERE status = 'verified';
CREATE INDEX ver_claims_revoked_at ON ver_claims(revoked_at) WHERE status = 'revoked';
CREATE INDEX ver_claims_pair_id ON ver_claims(pair_id) WHERE pair_id IS NOT NULL;
-- enforced by code today (organisations.mjs:108)
CREATE UNIQUE INDEX ver_claims_one_identity_per_user ON ver_claims(subject_id)
  WHERE subject_kind = 'user' AND claim_type = 'PERSON_IDENTITY'
    AND status IN ('unverified','collecting_evidence','pending','automated_checks_passed','requires_human_review','verified');
-- enforced by code today (organisations.mjs:211)
CREATE UNIQUE INDEX ver_claims_one_current_affiliation ON ver_claims(subject_id, organisation_id, claim_type)
  WHERE subject_kind = 'user' AND current = 1
    AND claim_type IN ('CLUB_AFFILIATION','CLUB_ROLE','AGENCY_AFFILIATION','AGENCY_ROLE','GRASSROOTS_AFFILIATION')
    AND status IN ('unverified','collecting_evidence','pending','automated_checks_passed','requires_human_review','verified');


-- -----------------------------------------------------------------------------
-- source: db.verClaims[].history[]  created at m14/shared.mjs:509 (mkClaim)
-- owner/writer: m14 migration only
-- lifecycle: append-only
-- mapping: history[] entries would be {id,at,byKind,byId,byName,action,detail}
--   by the shared histAppend convention -> columns of the same name.
-- notes: TODAY ALWAYS EMPTY — mkClaim initialises history: [] and nothing ever
--   pushes; createClaim does not even set the field. The audit trail for
--   claims lives in ver_events. Table kept so migrated rows with a non-empty
--   array (none expected) are not dropped silently; expected row count 0.
-- -----------------------------------------------------------------------------
CREATE TABLE ver_claim_history (
  id            TEXT PRIMARY KEY,
  ver_claim_id  TEXT NOT NULL REFERENCES ver_claims(id) ON DELETE CASCADE,
  at            INTEGER NOT NULL,
  by_kind       TEXT,
  by_id         TEXT,
  by_name       TEXT,                                      -- snapshot
  action        TEXT NOT NULL,
  detail_json   TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;

CREATE INDEX ver_claim_history_claim ON ver_claim_history(ver_claim_id, at);


-- -----------------------------------------------------------------------------
-- source: db.verEvents  created at m14/index.mjs:35 (verEvent) and
--         m14/shared.mjs:516 (migration rows vevt-m-N)
-- owner/writer: m14; append-only — nothing mutates or deletes a row
-- lifecycle: none (immutable)
-- mapping:
--   id -> id (vevt-N | vevt-m-N)
--   ts -> occurred_at (source field is literally `ts`)
--   type -> type
--   actorKind -> actor_kind   actorId -> actor_id   actorName -> actor_name
--   actorOrgId -> actor_org_id
--   requestId -> request_id (correlation id / x-request-id header)
--   attribution -> attribution (M14.1 reviewer attribution; NULL for org actors)
--   claimId -> ver_claim_id
--   subjectId -> subject_id (polymorphic: org_users.id, orgs.id, players.id,
--     ver_root_requests.id (evidence.added for root applications); no FK)
--   orgId -> org_id
--   before -> before_json   after -> after_json   reason -> reason
-- notes:
--   * Read pattern: by ver_claim_id (admin case view, chronological).
--   * type values are the closed set below; `claim.<status>` is generated
--     from CLAIM_STATES, the rest are literals in m14/*.mjs.
--   * subject_id/org_id FKs: org_id RESTRICT (audit must outlive org);
--     ver_claim_id RESTRICT.
-- -----------------------------------------------------------------------------
CREATE TABLE ver_events (
  id            TEXT PRIMARY KEY,
  occurred_at   INTEGER NOT NULL,                          -- source: ts
  type          TEXT NOT NULL CHECK (type IN (
                  'claim.created','claim.unverified','claim.collecting_evidence','claim.pending',
                  'claim.automated_checks_passed','claim.requires_human_review','claim.verified',
                  'claim.rejected','claim.expired','claim.suspended','claim.revoked','claim.disputed',
                  'claim.superseded','claim.reinstated','claim.corrected',
                  'review.requested','review.assigned','review.approved','review.rejected',
                  'automated_check.passed','automated_check.failed',
                  'evidence.added','evidence.accessed',
                  'email.challenge_sent','email.challenge_passed',
                  'security.self_verification_blocked',
                  'organisation.domain_added','organisation.domain_verified','organisation.domain_removed',
                  'admin.invited','admin.accepted','admin.revoked')),
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('org_user','system','trust_safety')),
  actor_id      TEXT,                                      -- org_users.id | reviewer id | 'admin' | NULL
  actor_name    TEXT,                                      -- snapshot
  actor_org_id  TEXT REFERENCES orgs(id) ON DELETE RESTRICT,
  request_id    TEXT,
  attribution   TEXT CHECK (attribution IS NULL OR attribution IN ('authenticated_reviewer','declared_reviewer','shared_admin_key')),
  ver_claim_id  TEXT REFERENCES ver_claims(id) ON DELETE RESTRICT,
  subject_id    TEXT,                                      -- polymorphic, see header
  org_id        TEXT REFERENCES orgs(id) ON DELETE RESTRICT,
  before_json   TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json    TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  reason        TEXT
) STRICT;

CREATE INDEX ver_events_claim ON ver_events(ver_claim_id, occurred_at);
CREATE INDEX ver_events_org ON ver_events(org_id, occurred_at);


-- -----------------------------------------------------------------------------
-- source: db.verEvidence  created at m14/index.mjs:99 (addEvidence); callers in
--         m14/organisations.mjs:137,262,961, m14/review.mjs:118,173 and
--         m29/index.mjs:176 (signing documents, via ctx.evidence.add)
-- owner/writer: m14 (+ m29 signing vault rows); never deleted
-- lifecycle: no status; retention policy string is declared but UNENFORCED
--   (no purge job exists); expires_at is always null today.
-- mapping:
--   id -> id (vevd-N)
--   type -> type ('document' | 'official_email' | 'registry_result' — the
--     three values written; EVIDENCE_TYPES also declares
--     organisation_confirmation, federation_confirmation, reference,
--     existing_claim which no code path writes)
--   source -> source ('subject_upload' | 'email_challenge' | 'root_application'
--     | 'club_upload' | a licence provider id such as 'local-test-registry')
--   suppliedByKind -> supplied_by_kind
--   suppliedById -> supplied_by_id (org_users.id for org_user,
--     ver_root_requests.id for applicant, NULL for system; polymorphic, no FK)
--   orgId -> org_id
--   claimIds[] -> ver_claim_evidence junction
--   receivedAt -> received_at
--   mediaId -> media_id (vfil-N storage key; never on a public path)
--   sha256 -> sha256 (hex digest of the exact bytes)
--   mime -> mime   bytes -> bytes   filename -> filename (≤120)
--   meta{} -> meta_json
--   checks.malwareScan -> check_malware_scan ('not_configured' always)
--   checks.contentSignature -> check_content_signature ('matched_claimed_type'
--     when a file was stored, NULL for note-only / email / registry rows)
--   retention -> retention
--   visibility -> visibility
--   expiresAt -> expires_at (always NULL today)
-- notes:
--   * Privacy: identity documents and licences (trust_and_safety visibility);
--     the row is never public; org readers see only organisation_internal rows
--     of their own org with media_id stripped (review.mjs:216).
--   * Duplicate detection: sha256 compared across ALL rows (risk signal).
--   * Read patterns: by id; by sha256; by (org_id, visibility); by
--     supplied_by_id; by meta.signingPackageId (m29 — JSON path, not indexed:
--     m29 keeps its own evidenceId on the signing document row).
-- -----------------------------------------------------------------------------
CREATE TABLE ver_evidence (
  id                      TEXT PRIMARY KEY,
  type                    TEXT NOT NULL CHECK (type IN ('document','official_email','registry_result')),
  source                  TEXT NOT NULL,
  supplied_by_kind        TEXT NOT NULL CHECK (supplied_by_kind IN ('org_user','applicant','system')),
  supplied_by_id          TEXT,                            -- org_users.id | ver_root_requests.id | NULL (no FK)
  org_id                  TEXT REFERENCES orgs(id) ON DELETE RESTRICT,
  received_at             INTEGER NOT NULL,
  media_id                TEXT,                            -- vfil-N storage key, never public
  sha256                  TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  mime                    TEXT CHECK (mime IS NULL OR mime IN ('application/pdf','image/png','image/jpeg','image/webp')),
  bytes                   INTEGER CHECK (bytes IS NULL OR (bytes > 0 AND bytes <= 8388608)),
  filename                TEXT CHECK (filename IS NULL OR length(filename) <= 120),
  meta_json               TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json) AND json_type(meta_json) = 'object'),
  check_malware_scan      TEXT NOT NULL DEFAULT 'not_configured' CHECK (check_malware_scan IN ('not_configured')),
  check_content_signature TEXT CHECK (check_content_signature IS NULL OR check_content_signature IN ('matched_claimed_type')),
  retention               TEXT NOT NULL DEFAULT 'until_claim_resolution' CHECK (retention IN ('until_claim_resolution','until_signing_resolution')),
  visibility              TEXT NOT NULL DEFAULT 'trust_and_safety' CHECK (visibility IN ('trust_and_safety','organisation_internal','subject_only')),
  expires_at              INTEGER
) STRICT;

CREATE INDEX ver_evidence_sha256 ON ver_evidence(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX ver_evidence_org_visibility ON ver_evidence(org_id, visibility);
CREATE INDEX ver_evidence_supplied_by ON ver_evidence(supplied_by_id);


-- -----------------------------------------------------------------------------
-- source: db.verClaims[].evidenceIds[] AND db.verEvidence[].claimIds[]
--         (maintained in tandem at organisations.mjs:142/262-268,
--         review.mjs:122/178; root-request evidence is attached to the
--         ORGANISATION_IDENTITY claim at review.mjs:438 via claim.evidenceIds
--         only — its claimIds stays [])
-- owner/writer: m14
-- lifecycle: rows are never removed
-- mapping: claim.evidenceIds[i] -> (ver_claim_id, ver_evidence_id);
--   evidence.claimIds[i] -> the same pair. Migration takes the UNION of both
--   sides; `position` preserves claim.evidenceIds order (evidence.claimIds[0]
--   is what verEvent('evidence.added') records as claimId).
-- notes: the side-table replaces two denormalised arrays; the pair is unique.
-- -----------------------------------------------------------------------------
CREATE TABLE ver_claim_evidence (
  ver_claim_id    TEXT NOT NULL REFERENCES ver_claims(id) ON DELETE CASCADE,
  ver_evidence_id TEXT NOT NULL REFERENCES ver_evidence(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ver_claim_id, ver_evidence_id)
) STRICT;

CREATE INDEX ver_claim_evidence_evidence ON ver_claim_evidence(ver_evidence_id);


-- -----------------------------------------------------------------------------
-- source: db.verTokens  created at m14/shared.mjs:299 (mintToken)
-- owner/writer: m14; never purged (expired/used rows stay)
-- lifecycle: single-use: used_at set on successful consume; expires_at checked
--   at peek; attempts_failed incremented on wrong-code attempts for the user's
--   open work_email tokens (organisations.mjs:251).
-- mapping:
--   id -> id (vtk-N)
--   hash -> token_hash (sha256 hex of the base64url secret; unsalted; the
--     plain secret is NEVER stored — it travels only in the email)
--   purpose -> purpose
--   email -> email (lower-cased recipient; NULL for identity-bound invites)
--   subjectKind -> subject_kind ('org_user' | 'player' | NULL)
--   subjectId -> subject_id (org_users.id | players.id; polymorphic, no FK)
--   orgId -> org_id
--   refId -> ref_id (polymorphic: ver_domain_requests.id for domain_email,
--     ver_player_invites.id for player_invite, ver_root_requests.id for
--     root_email; NULL for work_email)
--   createdAt -> created_at   expiresAt -> expires_at   usedAt -> used_at
--   attemptsFailed? -> attempts_failed (optional in source; default 0)
-- notes:
--   * Read patterns: by token_hash (unique); by (subject_id, purpose) for the
--     failure counter; by ref_id when checking the token belongs to a request.
--   * Privacy: email is personal data (plaintext).
-- -----------------------------------------------------------------------------
CREATE TABLE ver_tokens (
  id              TEXT PRIMARY KEY,
  token_hash      TEXT NOT NULL CHECK (length(token_hash) = 64),
  purpose         TEXT NOT NULL CHECK (purpose IN ('work_email','domain_email','player_invite','root_email')),
  email           TEXT,                                    -- personal data
  subject_kind    TEXT CHECK (subject_kind IS NULL OR subject_kind IN ('org_user','player')),
  subject_id      TEXT,                                    -- org_users.id | players.id (no FK)
  org_id          TEXT REFERENCES orgs(id) ON DELETE SET NULL,
  ref_id          TEXT,                                    -- polymorphic by purpose, see header
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER,
  attempts_failed INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE UNIQUE INDEX ver_tokens_hash ON ver_tokens(token_hash);
CREATE INDEX ver_tokens_subject_purpose ON ver_tokens(subject_id, purpose);
CREATE INDEX ver_tokens_ref ON ver_tokens(ref_id);


-- -----------------------------------------------------------------------------
-- source: db.verAdmins  created at m14/organisations.mjs:616,636 and
--         m14/review.mjs:459,495
-- owner/writer: m14
-- lifecycle: status active → revoked (revoke route, departed route); rows
--   never deleted
-- mapping:
--   id -> id (vadm-N)   orgId -> org_id   userId -> user_id   level -> level
--   status -> status
--   invitedBy -> invited_by (org_users.id, or literal 'trust_safety' when
--     appointed from the admin console; no FK)
--   createdAt -> created_at   acceptedAt -> accepted_at (always = created_at
--   today: there is no pending-acceptance step)
--   revokedAt -> revoked_at   revokedBy -> revoked_by (org_users.id)
-- notes:
--   * One ACTIVE row per (org, user, level) — enforced by code today
--     (ALREADY_GRANTED 409 / ALREADY_ROOT_ADMIN 409).
--   * Cannot revoke the last active root admin (LAST_ROOT_ADMIN) — code rule.
--   * Root-level grants/revokes require MFA on the acting account — code rule.
--   * Read patterns: (org_id, user_id, status) for verLevelFor;
--     (org_id, status) for reviewers/counters; m25/m26 notify active admins of
--     an org.
-- -----------------------------------------------------------------------------
CREATE TABLE ver_admins (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  user_id     TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  level       TEXT NOT NULL CHECK (level IN ('verification_viewer','verification_reviewer','verification_admin','verification_root_admin')),
  status      TEXT NOT NULL CHECK (status IN ('active','revoked')),
  invited_by  TEXT NOT NULL,                               -- org_users.id | 'trust_safety' (no FK)
  created_at  INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at  INTEGER,
  revoked_by  TEXT REFERENCES org_users(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX ver_admins_org_user_status ON ver_admins(org_id, user_id, status);
CREATE INDEX ver_admins_org_status ON ver_admins(org_id, status);
-- enforced by code today
CREATE UNIQUE INDEX ver_admins_one_active_grant ON ver_admins(org_id, user_id, level) WHERE status = 'active';


-- -----------------------------------------------------------------------------
-- source: db.verRootTransfers  created at m14/organisations.mjs:607
-- owner/writer: m14 (dual-control root-admin grants)
-- lifecycle: status pending → approved; no reject/expiry path exists
-- mapping:
--   id -> id (vrtx-N)   orgId -> org_id   toUserId -> to_user_id
--   proposedBy -> proposed_by   status -> status   createdAt -> created_at
--   approvedBy -> approved_by   approvedAt -> approved_at
-- notes:
--   * One pending transfer per org — enforced by code (TRANSFER_ALREADY_PENDING).
--   * approver ≠ proposer ≠ beneficiary — code rules at approve time.
--   * Known defect: a pending transfer can never be cancelled or rejected, so a
--     stale proposal blocks the org until approved.
--   * Read pattern: by org_id (admins console).
-- -----------------------------------------------------------------------------
CREATE TABLE ver_root_transfers (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  to_user_id  TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  proposed_by TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  status      TEXT NOT NULL CHECK (status IN ('pending','approved')),
  created_at  INTEGER NOT NULL,
  approved_by TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  approved_at INTEGER
) STRICT;

CREATE INDEX ver_root_transfers_org ON ver_root_transfers(org_id);
-- enforced by code today
CREATE UNIQUE INDEX ver_root_transfers_one_pending ON ver_root_transfers(org_id) WHERE status = 'pending';


-- -----------------------------------------------------------------------------
-- source: db.verRootRequests  created at m14/organisations.mjs:904
--         (public POST /auth/org/verification/apply)
-- owner/writer: m14 (applicant lane with applicant secret; T&S decision in
--   review.mjs:373/471)
-- lifecycle: status collecting_evidence → requires_human_review → approved |
--   rejected. ('pending' appears in two filters but is never written.)
-- mapping:
--   id -> id (vroot-N)   status -> status
--   orgName -> org_name (≤120)   orgType -> org_type   country -> country (≤40)
--   federation -> federation (≤80)   website -> website (≤200)
--   domain -> domain (normalised from body.domain || website)
--   applicantName -> applicant_name (≤80)   applicantRole -> applicant_role (≤60)
--   workEmail -> work_email (lower-cased)   officialContact -> official_contact (≤200)
--   declarations -> declarations_json (client object, stored as given, or NULL)
--   evidenceIds[] -> ver_root_request_evidence (junction)
--   checks.emailSyntax -> check_email_syntax
--   checks.emailDomainAlignment -> check_email_domain_alignment
--   checks.freeEmailProvider -> check_free_email_provider
--   checks.disposableEmail -> check_disposable_email
--   checks.domainNormalized -> check_domain_normalized ('(none)' when empty)
--   checks.dnsOwnership -> check_dns_ownership ('not_configured' — no probe exists)
--   checks.duplicateOrganisation -> check_duplicate_organisation
--   checks.duplicateRequest -> check_duplicate_request
--   checks.domainAlreadyVerifiedElsewhere -> check_domain_already_verified_elsewhere
--   checks.evidenceCompleteness -> check_evidence_completeness
--   riskFlags[] -> risk_flags_json   reviewReasons[] -> review_reasons_json
--   emailProved -> email_proved   existingOrgId -> existing_org_id
--   applicantSecretHash -> applicant_secret_hash (sha256 hex of randomHex(18);
--     unsalted; the secret is returned once at apply time, never stored)
--   createdAt -> created_at   decidedAt -> decided_at
--   decidedBy -> decided_by_name (source holds the reviewer NAME)
--   decidedById -> decided_by_id   decisionAttribution -> decision_attribution
--   decisionReason -> decision_reason (≤400)
--   resultOrgId -> result_org_id   resultUserId -> result_user_id
--   identityLink -> identity_link (set on approve only)
-- notes:
--   * Privacy: applicant_name / work_email / official_contact are personal
--     data; applicantSecretHash is stripped from every admin response.
--   * Approval may CREATE an org (review.mjs:382) and an org_user
--     (review.mjs:429) — result_* link to them.
--   * Read patterns: by id + secret hash compare (applicant); by status
--     (queue); by country (queue filter); by existing_org_id / result_org_id
--     with open status (orgVerificationStatus 'pending'); dup check by domain
--     and lower(org_name) among open requests.
-- -----------------------------------------------------------------------------
CREATE TABLE ver_root_requests (
  id                                      TEXT PRIMARY KEY,
  status                                  TEXT NOT NULL CHECK (status IN ('collecting_evidence','requires_human_review','approved','rejected')),
  org_name                                TEXT NOT NULL CHECK (length(org_name) <= 120),
  org_type                                TEXT NOT NULL CHECK (org_type IN ('professional club','academy','grassroots club','federation/association','agency','other approved football organisation')),
  country                                 TEXT NOT NULL CHECK (length(country) <= 40),
  federation                              TEXT CHECK (federation IS NULL OR length(federation) <= 80),
  website                                 TEXT NOT NULL CHECK (length(website) <= 200),
  domain                                  TEXT NOT NULL,                  -- normalised; '' when none could be derived
  applicant_name                          TEXT NOT NULL CHECK (length(applicant_name) <= 80),   -- personal data
  applicant_role                          TEXT NOT NULL CHECK (length(applicant_role) <= 60),
  work_email                              TEXT NOT NULL,                  -- personal data
  official_contact                        TEXT CHECK (official_contact IS NULL OR length(official_contact) <= 200), -- personal data
  declarations_json                       TEXT CHECK (declarations_json IS NULL OR json_valid(declarations_json)),
  check_email_syntax                      TEXT NOT NULL CHECK (check_email_syntax IN ('passed')),
  check_email_domain_alignment            TEXT NOT NULL CHECK (check_email_domain_alignment IN ('passed','mismatch')),
  check_free_email_provider               TEXT NOT NULL CHECK (check_free_email_provider IN ('passed','flagged')),
  check_disposable_email                  TEXT NOT NULL CHECK (check_disposable_email IN ('passed','flagged')),
  check_domain_normalized                 TEXT NOT NULL,
  check_dns_ownership                     TEXT NOT NULL CHECK (check_dns_ownership IN ('not_configured')),
  check_duplicate_organisation            TEXT NOT NULL CHECK (check_duplicate_organisation IN ('passed','flagged')),
  check_duplicate_request                 TEXT NOT NULL CHECK (check_duplicate_request IN ('passed','flagged')),
  check_domain_already_verified_elsewhere TEXT NOT NULL CHECK (check_domain_already_verified_elsewhere IN ('passed','flagged')),
  check_evidence_completeness             TEXT NOT NULL CHECK (check_evidence_completeness IN ('pending_email_proof','email_proved')),
  risk_flags_json                         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(risk_flags_json) AND json_type(risk_flags_json) = 'array'),
  review_reasons_json                     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(review_reasons_json) AND json_type(review_reasons_json) = 'array'),
  email_proved                            INTEGER NOT NULL DEFAULT 0 CHECK (email_proved IN (0,1)),
  existing_org_id                         TEXT REFERENCES orgs(id) ON DELETE SET NULL,
  applicant_secret_hash                   TEXT NOT NULL CHECK (length(applicant_secret_hash) = 64),
  created_at                              INTEGER NOT NULL,
  decided_at                              INTEGER,
  decided_by_name                         TEXT,                           -- snapshot (reviewer display name)
  decided_by_id                           TEXT,                           -- reviewer id | 'admin'
  decision_attribution                    TEXT CHECK (decision_attribution IS NULL OR decision_attribution IN ('authenticated_reviewer','declared_reviewer','shared_admin_key')),
  decision_reason                         TEXT CHECK (decision_reason IS NULL OR length(decision_reason) <= 400),
  result_org_id                           TEXT REFERENCES orgs(id) ON DELETE SET NULL,
  result_user_id                          TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  identity_link                           TEXT CHECK (identity_link IS NULL OR identity_link IN ('trust_safety_selection','provisioned_new_user','verified_work_email'))
) STRICT;

CREATE INDEX ver_root_requests_status ON ver_root_requests(status);
CREATE INDEX ver_root_requests_status_country ON ver_root_requests(status, country);
CREATE INDEX ver_root_requests_existing_org ON ver_root_requests(existing_org_id, status);
CREATE INDEX ver_root_requests_result_org ON ver_root_requests(result_org_id, status);
CREATE INDEX ver_root_requests_domain ON ver_root_requests(domain, status);


-- -----------------------------------------------------------------------------
-- source: db.verRootRequests[].evidenceIds[]  pushed at m14/organisations.mjs:966
-- owner/writer: m14 applicant evidence route
-- lifecycle: append-only; copied onto the ORGANISATION_IDENTITY claim at approval
-- mapping: evidenceIds[i] -> (ver_root_request_id, ver_evidence_id, position)
-- notes: the evidence rows themselves carry supplied_by_kind='applicant' and
--   supplied_by_id = the request id, visibility trust_and_safety.
-- -----------------------------------------------------------------------------
CREATE TABLE ver_root_request_evidence (
  ver_root_request_id TEXT NOT NULL REFERENCES ver_root_requests(id) ON DELETE CASCADE,
  ver_evidence_id     TEXT NOT NULL REFERENCES ver_evidence(id) ON DELETE CASCADE,
  position            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ver_root_request_id, ver_evidence_id)
) STRICT;


-- -----------------------------------------------------------------------------
-- source: db.verDisputes  created at m14/organisations.mjs:299 (openDispute)
-- owner/writer: m14 (subject opens; T&S resolves at review.mjs:540)
-- lifecycle: status open → resolved; never deleted
-- mapping:
--   id -> id (vdsp-N; prefix shared with m13 dispatches — see survey)
--   claimId -> ver_claim_id
--   byKind -> by_kind ('org_user' is the only value written: the sole caller
--     is the org subject route; ctx.openDispute is exported but unused)
--   byId -> by_id   byName -> by_name
--   reason -> reason (≤600)   status -> status
--   resolution -> resolution ('<action>: <reason≤300>' string)
--   createdAt -> created_at   resolvedAt -> resolved_at
--   resolvedBy -> resolved_by_name (source holds the reviewer NAME)
--   resolvedById -> resolved_by_id   resolutionAttribution -> resolution_attribution
-- notes:
--   * One open dispute per claim — enforced by code (DISPUTE_ALREADY_OPEN).
--   * Read patterns: by (ver_claim_id, status); global by status (queue).
-- -----------------------------------------------------------------------------
CREATE TABLE ver_disputes (
  id                     TEXT PRIMARY KEY,
  ver_claim_id           TEXT NOT NULL REFERENCES ver_claims(id) ON DELETE RESTRICT,
  by_kind                TEXT NOT NULL CHECK (by_kind IN ('org_user')),
  by_id                  TEXT NOT NULL,                     -- org_users.id
  by_name                TEXT,                              -- snapshot
  reason                 TEXT NOT NULL CHECK (length(reason) <= 600),
  status                 TEXT NOT NULL CHECK (status IN ('open','resolved')),
  resolution             TEXT,
  created_at             INTEGER NOT NULL,
  resolved_at            INTEGER,
  resolved_by_name       TEXT,                              -- snapshot
  resolved_by_id         TEXT,
  resolution_attribution TEXT CHECK (resolution_attribution IS NULL OR resolution_attribution IN ('authenticated_reviewer','declared_reviewer','shared_admin_key'))
) STRICT;

CREATE INDEX ver_disputes_claim_status ON ver_disputes(ver_claim_id, status);
CREATE INDEX ver_disputes_status ON ver_disputes(status);
-- enforced by code today
CREATE UNIQUE INDEX ver_disputes_one_open_per_claim ON ver_disputes(ver_claim_id) WHERE status = 'open';


-- -----------------------------------------------------------------------------
-- source: db.verReferences  created at m14/organisations.mjs:791 (new) and
--         :832 (correction = new version row)
-- owner/writer: m14; versioned — a correction inserts version+1 and marks the
--   old row superseded; withdrawal is a status change, text is kept
-- lifecycle: status active → withdrawn | superseded; never deleted
-- mapping:
--   id -> id (vref-N)   version -> version   supersedesId -> supersedes_id
--   playerId -> player_id   playerName -> player_name
--   coachUserId -> coach_user_id   coachName -> coach_name
--   orgId -> org_id   orgName -> org_name   roleAtTime -> role_at_time
--   provenanceSnapshot.claimId -> provenance_claim_id
--   provenanceSnapshot.claimType -> provenance_claim_type
--   provenanceSnapshot.status -> provenance_status ('verified' always)
--   provenanceSnapshot.method -> provenance_method
--   provenanceSnapshot.verifiedAt -> provenance_verified_at
--   provenanceSnapshot.snapshotAt -> provenance_snapshot_at
--   relationship -> relationship (≤80)   capacity -> capacity (≤120)
--   fromYear -> from_year   toYear -> to_year (Number(x)||null)
--   structured.strengths -> strengths (≤500)
--   structured.development -> development (≤500)
--   structured.summary -> summary (≤800)
--   status -> status   withdrawnAt -> withdrawn_at
--   withdrawReason -> withdraw_reason (≤300)   createdAt -> created_at
-- notes:
--   * Minor-safe: creation requires visibleToOrg + !isBlocked; a minor's
--     notification routes to the guardian.
--   * The provenance snapshot is never rewritten; "still current" is derived
--     at read (m15/passport.mjs:109, m162/trust.mjs:78).
--   * Read patterns: (player_id, status) [passport, player view, trust];
--     org_id [org list]; coach_user_id [withdraw/correct ownership].
-- -----------------------------------------------------------------------------
CREATE TABLE ver_references (
  id                     TEXT PRIMARY KEY,
  version                INTEGER NOT NULL DEFAULT 1,
  supersedes_id          TEXT REFERENCES ver_references(id) ON DELETE RESTRICT,
  player_id              TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  player_name            TEXT,                                -- snapshot
  coach_user_id          TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  coach_name             TEXT,                                -- snapshot
  org_id                 TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name               TEXT,                                -- snapshot
  role_at_time           TEXT,
  provenance_claim_id    TEXT NOT NULL REFERENCES ver_claims(id) ON DELETE RESTRICT,
  provenance_claim_type  TEXT NOT NULL,
  provenance_status      TEXT NOT NULL CHECK (provenance_status IN ('verified')),
  provenance_method      TEXT,
  provenance_verified_at INTEGER,
  provenance_snapshot_at INTEGER NOT NULL,
  relationship           TEXT NOT NULL CHECK (length(relationship) <= 80),
  capacity               TEXT NOT NULL DEFAULT '' CHECK (length(capacity) <= 120),
  from_year              INTEGER,
  to_year                INTEGER,
  strengths              TEXT NOT NULL DEFAULT '' CHECK (length(strengths) <= 500),
  development            TEXT NOT NULL DEFAULT '' CHECK (length(development) <= 500),
  summary                TEXT NOT NULL CHECK (length(summary) <= 800),
  status                 TEXT NOT NULL CHECK (status IN ('active','withdrawn','superseded')),
  withdrawn_at           INTEGER,
  withdraw_reason        TEXT CHECK (withdraw_reason IS NULL OR length(withdraw_reason) <= 300),
  created_at             INTEGER NOT NULL
) STRICT;

CREATE INDEX ver_references_player_status ON ver_references(player_id, status);
CREATE INDEX ver_references_org ON ver_references(org_id);
CREATE INDEX ver_references_coach ON ver_references(coach_user_id);


-- -----------------------------------------------------------------------------
-- source: db.verPlayerInvites  created at m14/organisations.mjs:705
-- owner/writer: m14 (org sends; adult player or guardian accepts :739)
-- lifecycle: status pending → accepted; expiry (14d) lives on the token and on
--   expires_at (not swept — an expired pending row stays pending)
-- mapping:
--   id -> id (vpin-N)   orgId -> org_id   byUserId -> by_user_id   byName -> by_name
--   name -> invitee_name (≤80, typed by the club)   squad -> squad (≤60)
--   status -> status   playerId -> player_id (set on acceptance)
--   targetPlayerId -> target_player_id (identity-bound invite, M14.1)
--   guardianApproved{guardianId,at} -> guardian_approved_guardian_id,
--     guardian_approved_at (NULL for adult self-acceptance)
--   createdAt -> created_at   expiresAt -> expires_at   acceptedAt -> accepted_at
--   (email is NOT on the row — it lives only on the ver_tokens row with
--   ref_id = this id)
-- notes:
--   * Rate limit 20 invites / org / rolling 24h — code rule; needs
--     (org_id, created_at).
--   * Minors: only the guardian may accept (guardianRouter) — code rule.
--   * Read patterns: (org_id, created_at); (player_id, status) [passport
--     squad rows]; by id from token ref.
-- -----------------------------------------------------------------------------
CREATE TABLE ver_player_invites (
  id                           TEXT PRIMARY KEY,
  org_id                       TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  by_user_id                   TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  by_name                      TEXT,                          -- snapshot
  invitee_name                 TEXT NOT NULL CHECK (length(invitee_name) <= 80),   -- personal data
  squad                        TEXT NOT NULL DEFAULT '' CHECK (length(squad) <= 60),
  status                       TEXT NOT NULL CHECK (status IN ('pending','accepted')),
  player_id                    TEXT REFERENCES players(id) ON DELETE SET NULL,
  target_player_id             TEXT REFERENCES players(id) ON DELETE SET NULL,
  guardian_approved_guardian_id TEXT REFERENCES guardians(id) ON DELETE SET NULL,
  guardian_approved_at         INTEGER,
  created_at                   INTEGER NOT NULL,
  expires_at                   INTEGER NOT NULL,
  accepted_at                  INTEGER
) STRICT;

CREATE INDEX ver_player_invites_org_created ON ver_player_invites(org_id, created_at);
CREATE INDEX ver_player_invites_player_status ON ver_player_invites(player_id, status);


-- -----------------------------------------------------------------------------
-- source: db.verConflicts  created at m14/organisations.mjs:667
-- owner/writer: m14 (self-declared conflicts of interest)
-- lifecycle: withdrawn_at soft-withdraw; never deleted
-- mapping:
--   id -> id (vcoi-N)   userId -> user_id   orgId -> org_id   kind -> kind
--   subject -> subject (≤120)   note -> note (≤400)
--   createdAt -> created_at   withdrawnAt -> withdrawn_at
-- notes:
--   * Visible to the declarer, the org's verification reviewers and T&S;
--     never public.
--   * Read patterns: by org_id (+ user_id for non-admins); by user_id with
--     withdrawn_at IS NULL (admin case view).
-- -----------------------------------------------------------------------------
CREATE TABLE ver_conflicts (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  kind         TEXT NOT NULL CHECK (kind IN ('family_relationship','agent_relationship','financial_interest','coaching_relationship','other')),
  subject      TEXT NOT NULL DEFAULT '' CHECK (length(subject) <= 120),
  note         TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 400),
  created_at   INTEGER NOT NULL,
  withdrawn_at INTEGER
) STRICT;

CREATE INDEX ver_conflicts_org_user ON ver_conflicts(org_id, user_id);
CREATE INDEX ver_conflicts_user ON ver_conflicts(user_id, withdrawn_at);


-- -----------------------------------------------------------------------------
-- source: db.verDomainRequests  created at m14/organisations.mjs:518
-- owner/writer: m14 (org admin requests; email challenge confirm :545; T&S
--   decide at review.mjs:510)
-- lifecycle: status email_challenge | requires_human_review → verified |
--   rejected; never deleted
-- mapping:
--   id -> id (vdom-N)   orgId -> org_id   domain -> domain (normalised)
--   requestedBy -> requested_by   status -> status
--   reviewReasons[] -> review_reasons_json (DOMAIN_OWNERSHIP_AMBIGUOUS may
--     appear twice — kept as an array for fidelity)
--   method -> method   createdAt -> created_at   decidedAt -> decided_at
--   decidedBy -> decided_by_name (reviewer NAME; NULL on the org email-confirm
--     path — known defect: that path records no actor)
--   decidedById -> decided_by_id (absent in source on the org path; NULL)
-- notes:
--   * Success appends to org_verified_domains and creates an
--     ORGANISATION_DOMAIN claim.
--   * Read patterns: by org_id (console); by status='requires_human_review'
--     (T&S).
-- -----------------------------------------------------------------------------
CREATE TABLE ver_domain_requests (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  domain              TEXT NOT NULL,
  requested_by        TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  status              TEXT NOT NULL CHECK (status IN ('email_challenge','requires_human_review','verified','rejected')),
  review_reasons_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(review_reasons_json) AND json_type(review_reasons_json) = 'array'),
  method              TEXT CHECK (method IS NULL OR method IN ('official_domain_email','scoutbox_manual_review')),
  created_at          INTEGER NOT NULL,
  decided_at          INTEGER,
  decided_by_name     TEXT,                                 -- snapshot
  decided_by_id       TEXT
) STRICT;

CREATE INDEX ver_domain_requests_org ON ver_domain_requests(org_id);
CREATE INDEX ver_domain_requests_status ON ver_domain_requests(status);


-- -----------------------------------------------------------------------------
-- source: db.verMigrated  (object, not an array) written at m14/shared.mjs:560
--         as { m14: { at, claims } }
-- owner/writer: m14 migrateM14 (one-time guard)
-- lifecycle: write-once per key
-- mapping: key ('m14') -> key; m14.at -> ran_at; m14.claims -> claims_created
--   (db.verClaims.length after the run, i.e. a count not a list)
-- notes: a keyed marker table; absence of the 'm14' row means the migration
--   must run.
-- -----------------------------------------------------------------------------
CREATE TABLE ver_migrations (
  key            TEXT PRIMARY KEY,
  ran_at         INTEGER NOT NULL,
  claims_created INTEGER NOT NULL
) STRICT;


-- -----------------------------------------------------------------------------
-- source: db.orgs[].verification.domains[]  pushed at m14/shared.mjs:534
--         (migration), organisations.mjs:556 (email challenge), review.mjs:446
--         (root approval), review.mjs:518 (T&S decide); removed (hard splice)
--         at organisations.mjs:573
-- owner/writer: m14
-- lifecycle: HARD DELETE on remove (the ver_events row
--   organisation.domain_removed is the only trace) — kept as a hard delete
--   here; status is always 'verified' (a domain only lands in the list once
--   proven).
-- mapping:
--   (parent org) -> org_id
--   domain -> domain (normalised)
--   status -> status ('verified' only)
--   method -> method
--   verifiedAt -> verified_at
--   addedBy -> added_by (org_users.id | 'migration' | 'root_request' |
--     'trust_safety'; no FK)
--   orgs[].verification.revokedAt / .orgType -> NOT here: scalar columns on
--     orgs in 01_identity.sql (orgs.verification_revoked_at,
--     orgs.verification_org_type); if that file does not carry them they must
--     be added there — they belong to the org row, not to the domain list.
-- notes:
--   * One entry per (org, domain) — enforced by code (DOMAIN_EXISTS 409).
--   * The same domain may be verified for two orgs (contested → human
--     review, not blocked); hence no global unique on domain.
--   * Root-domain removal needs root admin + MFA (isRoot derived from the
--     other entries of the same org) — code rule.
--   * Read patterns: by org_id (console, work-email coverage, risk flags);
--     by domain across orgs (contested-domain check, root duplicate check).
-- -----------------------------------------------------------------------------
CREATE TABLE org_verified_domains (
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  domain      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('verified')),
  method      TEXT NOT NULL CHECK (method IN ('official_domain_email','scoutbox_manual_review')),
  verified_at INTEGER NOT NULL,
  added_by    TEXT NOT NULL,                                -- org_users.id | 'migration' | 'root_request' | 'trust_safety'
  PRIMARY KEY (org_id, domain)
) STRICT;

CREATE INDEX org_verified_domains_domain ON org_verified_domains(domain);


-- =============================================================================
-- M15 — Football Passport
-- =============================================================================

-- -----------------------------------------------------------------------------
-- source: db.passportPrefs  created at m15/passport.mjs:37 (prefsFor — LAZY
--         INSERT ON READ: the first passport read for a player writes a row)
-- owner/writer: m15 (player or guardian PATCH)
-- lifecycle: one row per player, never deleted; updated_at NULL until the
--   first PATCH
-- mapping:
--   playerId -> player_id (natural PK)
--   bio -> bio (≤400, moderated)
--   positions -> position_primary (≤8) + position_secondary_json; positions
--     === null  ⇔  position_secondary_json IS NULL (and position_primary NULL)
--   positions.primary -> position_primary   positions.secondary[] -> position_secondary_json
--   positionHistory[] -> passport_position_history
--   availability -> availability
--   availableFrom -> available_from_raw (String(x).slice(0,10); not validated
--     as a date, hence no _date suffix)
--   publicSelections[] -> passport_public_selections
--   updatedAt -> updated_at
-- notes:
--   * Privacy: player-owned; a minor's row is edited by the guardian.
--   * Read pattern: by player_id (every passport assembly; m18 nobodyMissed).
-- -----------------------------------------------------------------------------
CREATE TABLE passport_prefs (
  player_id               TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  bio                     TEXT CHECK (bio IS NULL OR length(bio) <= 400),
  position_primary        TEXT CHECK (position_primary IS NULL OR length(position_primary) <= 8),
  position_secondary_json TEXT CHECK (position_secondary_json IS NULL OR (json_valid(position_secondary_json) AND json_type(position_secondary_json) = 'array')),
  availability            TEXT CHECK (availability IS NULL OR availability IN ('open_to_trials','open_to_contact','not_looking')),
  available_from_raw      TEXT CHECK (available_from_raw IS NULL OR length(available_from_raw) <= 10),
  updated_at              INTEGER
) STRICT;


-- -----------------------------------------------------------------------------
-- source: db.passportPrefs[].positionHistory[]  pushed at m15/passport.mjs:341
-- owner/writer: m15 (positionHistoryAdd in PATCH prefs)
-- lifecycle: append-only; no withdraw/delete path exists
-- mapping:
--   id -> id (ppos-N)   (parent) -> player_id
--   from -> from_raw_json (the FOOTBALL date the position started; raw client
--     value, see file header; validated only as normWhen()-parseable)
--   primary -> position_primary (≤8)   secondary[] -> position_secondary_json (≤3)
--   submittedBy -> submitted_by
--   recordedAt -> recorded_at (M18.1; NULL on rows written before it)
-- notes: read pattern: by player_id (timeline position_change events).
-- -----------------------------------------------------------------------------
CREATE TABLE passport_position_history (
  id                      TEXT PRIMARY KEY,
  player_id               TEXT NOT NULL REFERENCES passport_prefs(player_id) ON DELETE CASCADE,
  from_raw_json           TEXT NOT NULL CHECK (json_valid(from_raw_json)),
  position_primary        TEXT NOT NULL CHECK (length(position_primary) <= 8),
  position_secondary_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(position_secondary_json) AND json_type(position_secondary_json) = 'array'),
  submitted_by            TEXT NOT NULL CHECK (submitted_by IN ('player','guardian')),
  recorded_at             INTEGER
) STRICT;

CREATE INDEX passport_position_history_player ON passport_position_history(player_id);


-- -----------------------------------------------------------------------------
-- source: db.passportPrefs[].publicSelections[]  replaced wholesale at
--         m15/passport.mjs:359 (≤100 strings ≤120 chars)
-- owner/writer: m15 (PATCH prefs)
-- lifecycle: full replace on each PATCH (delete + insert)
-- mapping: publicSelections[i] -> selection; the array is consumed as a Set
--   (projection) so duplicates carry no meaning — composite PK dedupes them.
-- notes: values are timeline event ids ('pev:...'), 'hist:<orgName>' keys or
--   anything the client sends (unknown ids are stored harmlessly and can never
--   widen visibility — enforced at projection).
-- -----------------------------------------------------------------------------
CREATE TABLE passport_public_selections (
  player_id TEXT NOT NULL REFERENCES passport_prefs(player_id) ON DELETE CASCADE,
  selection TEXT NOT NULL CHECK (length(selection) <= 120),
  PRIMARY KEY (player_id, selection)
) STRICT;


-- -----------------------------------------------------------------------------
-- source: db.passportCareerEntries  created at m15/passport.mjs:387
-- owner/writer: m15 (player or guardian; player-only withdraw at :407)
-- lifecycle: withdrawn_at soft delete; never hard-deleted
-- mapping:
--   id -> id (pcar-N)   playerId -> player_id
--   orgName -> org_name (free text ≤100 — NOT an orgs FK; matched to
--     authoritative rows by lower-cased name at read)
--   role -> role (≤60)
--   from -> from_raw_json   to -> to_raw_json (raw client values, see header)
--   note -> note (≤200)   submittedBy -> submitted_by
--   createdAt -> created_at   withdrawnAt -> withdrawn_at
-- notes:
--   * Provenance is derived at read from submitted_by (player_submitted /
--     guardian_submitted); never stored.
--   * Known defect: the guardian lane has no withdraw route — only the
--     player route exists, and a minor cannot call it.
--   * Read pattern: by player_id.
-- -----------------------------------------------------------------------------
CREATE TABLE passport_career_entries (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  org_name      TEXT NOT NULL CHECK (length(org_name) <= 100),
  role          TEXT CHECK (role IS NULL OR length(role) <= 60),
  from_raw_json TEXT NOT NULL CHECK (json_valid(from_raw_json)),
  to_raw_json   TEXT CHECK (to_raw_json IS NULL OR json_valid(to_raw_json)),
  note          TEXT CHECK (note IS NULL OR length(note) <= 200),
  submitted_by  TEXT NOT NULL CHECK (submitted_by IN ('player','guardian')),
  created_at    INTEGER NOT NULL,
  withdrawn_at  INTEGER
) STRICT;

CREATE INDEX passport_career_entries_player ON passport_career_entries(player_id);


-- -----------------------------------------------------------------------------
-- source: db.passportAchievements  created at m15/passport.mjs:429; confirmed
--         by a verified org at :453
-- owner/writer: m15
-- lifecycle: withdrawn_at soft delete (refused once confirmed); confirmation
--   is write-once (ALREADY_CONFIRMED 409)
-- mapping:
--   id -> id (pach-N)   playerId -> player_id   title -> title (≤120)
--   orgName -> org_name (free text ≤100)
--   when -> when_raw_json (raw client value; NULL allowed)
--   submittedBy -> submitted_by
--   confirmation -> NULL ⇔ confirmation_at IS NULL
--   confirmation.provenance -> confirmation_provenance ('verified_club_confirmed')
--   confirmation.orgId -> confirmation_org_id
--   confirmation.orgName -> confirmation_org_name
--   confirmation.byName -> confirmation_by_name (staff name; never shown to
--     the player — the org stands behind the confirmation)
--   confirmation.at -> confirmation_at
--   createdAt -> created_at   withdrawnAt -> withdrawn_at
-- notes:
--   * Only a verified org that can see the player may confirm — code rule.
--   * Read pattern: by player_id.
-- -----------------------------------------------------------------------------
CREATE TABLE passport_achievements (
  id                      TEXT PRIMARY KEY,
  player_id               TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  title                   TEXT NOT NULL CHECK (length(title) <= 120),
  org_name                TEXT CHECK (org_name IS NULL OR length(org_name) <= 100),
  when_raw_json           TEXT CHECK (when_raw_json IS NULL OR json_valid(when_raw_json)),
  submitted_by            TEXT NOT NULL CHECK (submitted_by IN ('player','guardian')),
  confirmation_provenance TEXT CHECK (confirmation_provenance IS NULL OR confirmation_provenance IN ('verified_club_confirmed')),
  confirmation_org_id     TEXT REFERENCES orgs(id) ON DELETE RESTRICT,
  confirmation_org_name   TEXT,                             -- snapshot
  confirmation_by_name    TEXT,                             -- snapshot (staff name, org-internal)
  confirmation_at         INTEGER,
  created_at              INTEGER NOT NULL,
  withdrawn_at            INTEGER
) STRICT;

CREATE INDEX passport_achievements_player ON passport_achievements(player_id);


-- -----------------------------------------------------------------------------
-- source: db.passportShares  created at m15/sharing.mjs:31
-- owner/writer: m15 (adult player or guardian creates/revokes; T&S revokes)
-- lifecycle: revoked_at soft revoke; expires_at 1–90 days; multi-use until
--   revoked/expired; never deleted
-- mapping:
--   id -> id (pshr-N)   playerId -> player_id   mode -> mode
--   tokenHash -> token_hash (sha256 hex of a 24-byte base64url secret; the
--     secret exists only in the create response / QR URL)
--   createdBy{kind,id} -> created_by_kind, created_by_id
--   createdAt -> created_at   expiresAt -> expires_at
--   revokedAt -> revoked_at   revokedBy{kind,id} -> revoked_by_kind, revoked_by_id
--   views -> views (incremented on every successful resolve)
-- notes:
--   * token_hash unique (resolver lookup). Public shares resolve to the SAFE
--     PUBLIC projection; recruitment shares still re-run orgCanSee.
--   * Minors: guardian-managed only — code rule.
--   * Read patterns: by token_hash; by player_id (lists, active count).
-- -----------------------------------------------------------------------------
CREATE TABLE passport_shares (
  id              TEXT PRIMARY KEY,
  player_id       TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mode            TEXT NOT NULL CHECK (mode IN ('public','recruitment')),
  token_hash      TEXT NOT NULL CHECK (length(token_hash) = 64),
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('player','guardian')),
  created_by_id   TEXT NOT NULL,                            -- players.id | guardians.id (polymorphic, no FK)
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  revoked_by_kind TEXT CHECK (revoked_by_kind IS NULL OR revoked_by_kind IN ('player','guardian','trust_safety')),
  revoked_by_id   TEXT,                                     -- players.id | guardians.id | 'admin'
  views           INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE UNIQUE INDEX passport_shares_token_hash ON passport_shares(token_hash);
CREATE INDEX passport_shares_player ON passport_shares(player_id);


-- -----------------------------------------------------------------------------
-- source: db.passportCorrections  created at m15/passport.mjs:469; resolved by
--         T&S at :490
-- owner/writer: m15
-- lifecycle: status open → resolved; never deleted
-- mapping:
--   id -> id (pcor-N)   playerId -> player_id
--   targetType -> target_kind   targetId -> target_id (≤80; polymorphic by
--     target_kind: timeline event id 'pev:...', passport_career_entries.id,
--     'hist:<org>' key, ver_references.id, trials.id, assessments.id,
--     passport_achievements.id, signings.id; no FK)
--   reason -> reason (≤500, moderated)
--   by{kind,id,name} -> by_kind, by_id, by_name
--   status -> status
--   resolution.outcome -> resolution_outcome
--   resolution.reason -> resolution_reason (≤400)
--   resolution.at -> resolved_at (same instant as resolvedAt; the two
--     Date.now() calls at :498-:499 are collapsed into one column)
--   resolvedAt -> resolved_at
--   createdAt -> created_at
-- notes:
--   * Known defect: the RESOLVER identity is not stored (admin shared key).
--   * Read patterns: by status + created_at asc (T&S queue; ?all=1 lists all).
-- -----------------------------------------------------------------------------
CREATE TABLE passport_corrections (
  id                 TEXT PRIMARY KEY,
  player_id          TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  target_kind        TEXT NOT NULL CHECK (target_kind IN ('timeline_event','career_entry','club_history','reference','trial','assessment','achievement','signing')),
  target_id          TEXT CHECK (target_id IS NULL OR length(target_id) <= 80),
  reason             TEXT NOT NULL CHECK (length(reason) <= 500),
  by_kind            TEXT NOT NULL CHECK (by_kind IN ('player','guardian')),
  by_id              TEXT NOT NULL,                         -- players.id | guardians.id (polymorphic, no FK)
  by_name            TEXT,                                  -- snapshot
  status             TEXT NOT NULL CHECK (status IN ('open','resolved')),
  resolution_outcome TEXT CHECK (resolution_outcome IS NULL OR resolution_outcome IN ('corrected','rejected','referred')),
  resolution_reason  TEXT CHECK (resolution_reason IS NULL OR length(resolution_reason) <= 400),
  created_at         INTEGER NOT NULL,
  resolved_at        INTEGER
) STRICT;

CREATE INDEX passport_corrections_status_created ON passport_corrections(status, created_at);
CREATE INDEX passport_corrections_player ON passport_corrections(player_id);


-- =============================================================================
-- M13 F2 — consent-based transition cases
-- =============================================================================

-- -----------------------------------------------------------------------------
-- source: db.transitionCases  created at m13/transitions.mjs:42
-- owner/writer: m13 transitions (adult player or guardian own the case; clubs
--   only read through a live grant)
-- lifecycle: status open → withdrawn | placed | expired (sweep at
--   periodEndsAt); never deleted
-- mapping:
--   id -> id (trn-N)   playerId -> player_id   playerName -> player_name
--   startedBy{kind,id,name} -> started_by_kind, started_by_id, started_by_name
--   caseOwner{kind,id,name} -> derived, not stored: always a copy of startedBy
--     at creation and never reassigned (transitions.mjs:44)
--   note -> note (≤500)
--   pack{mediaIds[],evidenceIds[],feedbackIds[]} -> transition_case_pack_items
--   periodEndsAt -> period_ends_at (14–180 days)
--   recipients[] -> transition_case_recipients
--   status -> status
--   placement{orgId,orgName,at,note} -> placement_org_id, placement_org_name,
--     placement_at, placement_note (≤300)
--   followUp{dueAt,completedAt,notifiedAt} -> follow_up_due_at,
--     follow_up_completed_at (initialised null, NEVER set by any route —
--     kept for fidelity), follow_up_notified_at (sweep)
--   createdAt -> created_at
--   history[] -> transition_case_history
-- notes:
--   * Minors: only the guardian may open/own a case — code rule.
--   * Agencies can never be recipients — code rule.
--   * Read patterns: by player_id (player/guardian list); by recipient org
--     with a live grant (club list) — see transition_case_recipients.
-- -----------------------------------------------------------------------------
CREATE TABLE transition_cases (
  id                     TEXT PRIMARY KEY,
  player_id              TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  player_name            TEXT,                              -- snapshot
  started_by_kind        TEXT NOT NULL CHECK (started_by_kind IN ('player','guardian')),
  started_by_id          TEXT NOT NULL,                     -- players.id | guardians.id (polymorphic, no FK)
  started_by_name        TEXT,                              -- snapshot
  note                   TEXT CHECK (note IS NULL OR length(note) <= 500),
  period_ends_at         INTEGER NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('open','withdrawn','placed','expired')),
  placement_org_id       TEXT REFERENCES orgs(id) ON DELETE SET NULL,
  placement_org_name     TEXT,                              -- snapshot
  placement_at           INTEGER,
  placement_note         TEXT CHECK (placement_note IS NULL OR length(placement_note) <= 300),
  follow_up_due_at       INTEGER,
  follow_up_completed_at INTEGER,                           -- never written non-null today
  follow_up_notified_at  INTEGER,
  created_at             INTEGER NOT NULL
) STRICT;

CREATE INDEX transition_cases_player ON transition_cases(player_id);
CREATE INDEX transition_cases_status_period ON transition_cases(status, period_ends_at);


-- -----------------------------------------------------------------------------
-- source: db.transitionCases[].pack.{mediaIds,evidenceIds,feedbackIds}[]
--         built at m13/transitions.mjs:19 (buildPack whitelist)
-- owner/writer: m13 transitions; written once at case creation
-- lifecycle: immutable after creation
-- mapping: pack.mediaIds[i] -> (case_id, 'media', item_id) — players.media[].id
--   (player-owned media, table in 01_identity.sql); pack.evidenceIds[i] ->
--   (case_id, 'evidence', item_id) — evidence.id; pack.feedbackIds[i] ->
--   (case_id, 'feedback', item_id) — assessments.id with publishedFeedback.
-- notes: polymorphic by item_kind, so no FK; at least one item is required by
--   code (PACK_EMPTY 400).
-- -----------------------------------------------------------------------------
CREATE TABLE transition_case_pack_items (
  transition_case_id TEXT NOT NULL REFERENCES transition_cases(id) ON DELETE CASCADE,
  item_kind          TEXT NOT NULL CHECK (item_kind IN ('media','evidence','feedback')),
  item_id            TEXT NOT NULL,                         -- player media id | evidence.id | assessments.id
  PRIMARY KEY (transition_case_id, item_kind, item_id)
) STRICT;


-- -----------------------------------------------------------------------------
-- source: db.transitionCases[].recipients[]  pushed at m13/transitions.mjs:93
-- owner/writer: m13 transitions (grant / revoke / withdraw / place / club view)
-- lifecycle: revoked_at soft revoke (also set for every other recipient on
--   placement and for all on withdraw); expiry by expires_at (≤ case period)
-- mapping:
--   (parent) -> transition_case_id
--   orgId -> org_id   orgName -> org_name
--   grantedAt -> granted_at   expiresAt -> expires_at
--   revokedAt -> revoked_at   viewedAt -> viewed_at (last pack open)
-- notes:
--   * No id in source; natural PK (case, org, granted_at) — a club can be
--     re-granted after a revoke/expiry, so (case, org) alone is not unique.
--   * "Active" = revoked_at IS NULL AND expires_at > now — time-dependent, so
--     the one-active-grant-per-org rule (ALREADY_GRANTED) stays a code rule.
--   * Read pattern: by org_id where revoked_at IS NULL (club list + pack view).
-- -----------------------------------------------------------------------------
CREATE TABLE transition_case_recipients (
  transition_case_id TEXT NOT NULL REFERENCES transition_cases(id) ON DELETE CASCADE,
  org_id             TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name           TEXT,                                  -- snapshot
  granted_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  revoked_at         INTEGER,
  viewed_at          INTEGER,
  PRIMARY KEY (transition_case_id, org_id, granted_at)
) STRICT;

CREATE INDEX transition_case_recipients_org ON transition_case_recipients(org_id, revoked_at, expires_at);


-- -----------------------------------------------------------------------------
-- source: db.transitionCases[].history[]  via histAppend (m13/shared.mjs:206)
-- owner/writer: m13 transitions
-- lifecycle: append-only
-- mapping: id -> id (aud-N)   at -> at   byKind -> by_kind ('player' |
--   'guardian' | 'system')   byId -> by_id ('sweep' for system)   byName -> by_name
--   action -> action ('opened','recipient_added','recipient_revoked',
--   'withdrawn','placed','expired')   detail -> detail_json
-- -----------------------------------------------------------------------------
CREATE TABLE transition_case_history (
  id                 TEXT PRIMARY KEY,
  transition_case_id TEXT NOT NULL REFERENCES transition_cases(id) ON DELETE CASCADE,
  at                 INTEGER NOT NULL,
  by_kind            TEXT CHECK (by_kind IS NULL OR by_kind IN ('player','guardian','system')),
  by_id              TEXT,
  by_name            TEXT,                                  -- snapshot
  action             TEXT NOT NULL CHECK (action IN ('opened','recipient_added','recipient_revoked','withdrawn','placed','expired')),
  detail_json        TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;

CREATE INDEX transition_case_history_case ON transition_case_history(transition_case_id, at);


-- =============================================================================
-- M13 F10 — legacy adult representation (creation closed, M23 P5.6E)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- source: db.representations  originally created by POST /org/representation/
--         propose (commit e865531, m13/transitions.mjs:247 at the time); that
--         route now returns 410 REPRESENTATION_LANE_CLOSED (transitions.mjs:256)
--         — NO new rows can be created. Existing rows are read as history and
--         were mirrored into representationAgreements by m182 migration 2305.
-- owner/writer: m13 transitions (player confirm/withdraw/dispute and T&S
--   credential review remain OPEN)
-- lifecycle: status proposed → active → withdrawn | disputed; 'expired' is
--   DERIVED at read (repFresh: active with end_at < now) and never stored
-- mapping:
--   id -> id (rep-N — prefix shared with reports and trial reports)
--   playerId -> player_id   playerName -> player_name
--   agencyOrgId -> agency_org_id   agencyName -> agency_name
--   representativeName -> representative_name (≤80)
--   scope -> scope
--   startAt -> start_at   endAt -> end_at (1–36 months from start, or NULL)
--   credential -> NULL ⇔ credential_source IS NULL
--   credential.source -> credential_source ('uploaded_document')
--   credential.note -> credential_note (≤200)
--   credential.reviewStatus -> credential_review_status
--   credential.reviewedAt -> credential_reviewed_at
--   status -> status   confirmedAt -> confirmed_at   withdrawnAt -> withdrawn_at
--   disputedAt -> disputed_at   disputeReason -> dispute_reason (≤300)
--   createdAt -> created_at
--   history[] -> representation_history
-- notes:
--   * Adults only — DOB checked live on every route, never a stored flag.
--   * Legacy rows feed the Passport timeline (history only) and M14 migrated
--     LICENCE claims (metadata.representationId).
--   * Read patterns: by player_id; by agency_org_id; all (admin).
-- -----------------------------------------------------------------------------
CREATE TABLE representations (
  id                       TEXT PRIMARY KEY,
  player_id                TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  player_name              TEXT,                            -- snapshot
  agency_org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  agency_name              TEXT,                            -- snapshot
  representative_name      TEXT CHECK (representative_name IS NULL OR length(representative_name) <= 80),
  scope                    TEXT NOT NULL CHECK (scope IN ('full','contracts_only','commercial_only')),
  start_at                 INTEGER,
  end_at                   INTEGER,
  credential_source        TEXT CHECK (credential_source IS NULL OR credential_source IN ('uploaded_document')),
  credential_note          TEXT CHECK (credential_note IS NULL OR length(credential_note) <= 200),
  credential_review_status TEXT CHECK (credential_review_status IS NULL OR credential_review_status IN ('pending','reviewed_valid','reviewed_invalid')),
  credential_reviewed_at   INTEGER,
  status                   TEXT NOT NULL CHECK (status IN ('proposed','active','withdrawn','disputed')),
  confirmed_at             INTEGER,
  withdrawn_at             INTEGER,
  disputed_at              INTEGER,
  dispute_reason           TEXT CHECK (dispute_reason IS NULL OR length(dispute_reason) <= 300),
  created_at               INTEGER NOT NULL
) STRICT;

CREATE INDEX representations_player ON representations(player_id);
CREATE INDEX representations_agency ON representations(agency_org_id);


-- -----------------------------------------------------------------------------
-- source: db.representations[].history[]  via histAppend (m13/shared.mjs:206)
-- owner/writer: m13 transitions
-- lifecycle: append-only
-- mapping: id -> id (aud-N)   at -> at   byKind -> by_kind ('org' | 'player' |
--   'admin')   byId -> by_id (org_users.id | players.id | 'ts')   byName -> by_name
--   action -> action ('proposed','confirmed','withdrawn','disputed',
--   'credential_reviewed')   detail -> detail_json
-- -----------------------------------------------------------------------------
CREATE TABLE representation_history (
  id                TEXT PRIMARY KEY,
  representation_id TEXT NOT NULL REFERENCES representations(id) ON DELETE CASCADE,
  at                INTEGER NOT NULL,
  by_kind           TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','player','admin')),
  by_id             TEXT,
  by_name           TEXT,                                   -- snapshot
  action            TEXT NOT NULL CHECK (action IN ('proposed','confirmed','withdrawn','disputed','credential_reviewed')),
  detail_json       TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;

CREATE INDEX representation_history_rep ON representation_history(representation_id, at);


-- =============================================================================
-- Core — coach vouches (email-code references)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- source: db.vouches  created at server.mjs:3689 (createVouchRequest; player
--         or guardian request) and server.mjs:2823 (club release reference —
--         published immediately, no email, no code)
-- owner/writer: server.mjs (request, /vouch/submit publish, admin revoke) and
--   m12/passport.mjs:369 (admin withdraw)
-- lifecycle: status pending → published → revoked; withdrawn_at is a separate
--   T&S soft-withdraw on a published row; never deleted — survives player
--   deletion WITH names (known retention defect)
-- mapping:
--   id -> id (vch-N)   playerId -> player_id   playerName -> player_name
--   coachName -> coach_name   coachEmail -> coach_email (NULL on release path)
--   role -> role
--   status -> status
--   code -> code_hash (sha256 hex of the 8-char upper-case randomCode; stored
--     PLAIN today at server.mjs:3692 and compared plain at :4073; nulled on
--     publish — single use)
--   text -> text (≤400, moderated)   seasons -> seasons (≤40)
--   ts -> created_at (source field is literally `ts`)
--   publishedAt -> published_at
--   conflictOfInterest -> conflict_of_interest (≤200; only the submit path
--     sets it, release rows have no such key → NULL)
--   withdrawn{at,by,reason} -> withdrawn_at, withdrawn_by ('admin'),
--     withdrawn_reason (≤200)
--   verificationMethod -> derived, not stored: never written; every reader
--     defaults it to 'email_code' (server.mjs:969, m12/passport.mjs:103)
--   identityVerified -> derived, not stored: never written; readers default
--     it to false (an email code proves mailbox control, not identity)
-- notes:
--   * Privacy: coach_email is personal data; coach_email and code are
--     stripped from every player/org view (server.mjs:965, :3126).
--   * Read patterns: (player_id, status) with withdrawn_at IS NULL [profile,
--     passport counts, season wrap]; by code_hash where status='pending'
--     [submit]; by id [admin revoke/withdraw]; all reversed [admin list].
-- -----------------------------------------------------------------------------
CREATE TABLE vouches (
  id                   TEXT PRIMARY KEY,
  player_id            TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  player_name          TEXT,                                -- snapshot
  coach_name           TEXT NOT NULL,                       -- personal data
  coach_email          TEXT,                                -- personal data
  role                 TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('pending','published','revoked')),
  code_hash            TEXT CHECK (code_hash IS NULL OR length(code_hash) = 64),
  text                 TEXT CHECK (text IS NULL OR length(text) <= 400),
  seasons              TEXT CHECK (seasons IS NULL OR length(seasons) <= 40),
  created_at           INTEGER NOT NULL,                    -- source: ts
  published_at         INTEGER,
  conflict_of_interest TEXT CHECK (conflict_of_interest IS NULL OR length(conflict_of_interest) <= 200),
  withdrawn_at         INTEGER,
  withdrawn_by         TEXT CHECK (withdrawn_by IS NULL OR withdrawn_by IN ('admin')),
  withdrawn_reason     TEXT CHECK (withdrawn_reason IS NULL OR length(withdrawn_reason) <= 200)
) STRICT;

CREATE INDEX vouches_player_status ON vouches(player_id, status);
CREATE INDEX vouches_code_hash ON vouches(code_hash) WHERE code_hash IS NOT NULL AND status = 'pending';


-- =============================================================================
-- not tables:
--   * CLAIM_TYPES, CLAIM_STATES, METHODS, AUTHORITATIVE_METHODS,
--     VALID_TRANSITIONS, REVIEW_REASONS, EVIDENCE_TYPES, EVIDENCE_VISIBILITY,
--     EVIDENCE_MIME_ALLOW, VER_LEVELS, FREE_MAIL_DOMAINS, DISPOSABLE_DOMAINS
--     — code registries in m14/shared.mjs (CHECK constraints above mirror the
--     written subset).
--   * licenceProviders() / TEST_REGISTRY_ROWS (m14/review.mjs) — provider
--     registry and env-gated test fixture; the lookup RESULT is stored on the
--     claim (metadata.registry) and as a registry_result evidence row.
--   * buildClaimIndex (bySubject / byAuthority) — in-memory index rebuilt on
--     boot; replaced by ver_claims_subject / ver_claims_authority.
--   * effectiveStatus(), orgVerificationStatus(), orgCanAttest(),
--     assuranceForClaim(), toPublicVerificationProfile(), badge labels —
--     derived at read time; nothing caches a verified boolean.
--   * metrics.verification / metrics.passport counters — in-memory, reset on
--     boot.
--   * verificationSweep / transitionSweep timers — schedulers, not state.
--   * PROVENANCE, PROVENANCE_COPY, VISIBILITY, VIEWERS, GAP_RULES,
--     GAP_RULES_VERSION (m15/shared.mjs) — code registries.
--   * Passport timeline, clubHistory, currentStatus, temporalConflicts,
--     completeness, evidenceSummary, developmentActivity, combine projection,
--     passportRevision (pr_<sha1>) — all derived per read from the tables in
--     this file plus evidence/assessments/trials/signings/squads; the
--     revision is copied into roomSnapshots (04) at decision time only.
--   * passport share rate limiter (`attempts` Map, sharing.mjs:101) — in-memory.
--   * representation `expired` status — derived (repFresh).
--   * caseOwner on transition cases — a copy of startedBy; derived.
--   * vouches.verificationMethod / identityVerified — read-time defaults.
--   * orgs.verification.revokedAt / orgs.verification.orgType — scalar
--     columns on orgs (01_identity.sql), not a verification table.
-- =============================================================================
