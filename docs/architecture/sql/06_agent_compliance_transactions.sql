-- =============================================================================
-- 06_agent_compliance_transactions.sql
-- ScoutBox target relational schema — Agent core (m24), Conflict & Compliance
-- Engine (m25), Agent Transaction Workspace (m26) and the m27 writes that land
-- on m24 records (opportunity shares; the recruitment-case handoff is on
-- recruitment_cases and belongs to 02_recruitment.sql).
--
-- Source collections (created by domains/platform/migrations.mjs): agentProfiles,
-- agencyAffiliations, representationAgreements (step 2305, lines 391-393);
-- tsReviewers, jurisdictionPolicies, regulatoryReviews, regulatoryConsents,
-- complianceContexts (step 2306, lines 471-475); agentTransactions,
-- transactionRepresentations, transactionDocuments (step 2307, lines 547-549);
-- orgs.agencySettings (domains/agents/core/index.mjs:443, no migration step).
--
-- Conventions: see ddl-conventions.md. All epoch-ms instants are INTEGER *_at;
-- all optimistic-concurrency tokens are rev / rev_at / rev_by_*; every
-- `keys.<action> {key, fp}` idempotency slot is NOT a column here but a row in
-- the shared `idempotency_keys` table (02_recruitment.sql): one row per
-- (owner table, owner record id, action, key, fp) — the mapping comment of each
-- table names the action values it uses. `fp` is payloadFingerprint(): the
-- sorted-key JSON of the request parts (domains/recruitment/lifecycle/contact.mjs:337), not a hash.
--
-- Actor objects `by {kind, userId, name, role?, orgId?}` become by_kind /
-- by_id / by_name / by_role / by_org_id. Kinds written by these modules:
-- org, player, club_user, ts_reviewer, system.
--
-- Table order is dictated by FK dependencies: ts_reviewers → policies →
-- profiles → affiliations → agreements (+shares) → org settings → reviews →
-- contexts (+evaluations) → consents → transactions (+children) →
-- transaction representations → transaction documents. Three references form
-- cycles (profile facet provenance → review; agreement dispute → review; review
-- subject → context / transaction) and are plain columns with a comment.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- S11b-1: IMPLEMENTED, migration 0027_compliance_policies REGISTERED (repositories/compliancePolicies.mjs, 5 Nov 2026).
-- The definitions below are the migration's DDL (generated from the repository's field specs, like S10a–S11a);
-- scripts/testSchemaDdl.mjs compares them column by column.
-- Sources: domains/agents/compliance/index.mjs (reviewers: the dev seed, the operator bootstrap, POST /ts/reviewers and
-- its revoke; policy versions: POST /ts/compliance/policies and its approve); the three seeded versions
-- (domains/agents/compliance/policyVersions.mjs) are inserted by the migration, attributed to it.
-- How the model differs from the first draft of this file:
--   * No JSON columns. A rule's parameters are typed against the engine's vocabulary (RULE_PARAMS in
--     policyVersions.mjs): one row per parameter, its scalar value a flag, count or text column; a list's, a role
--     set's or an age map's elements are jurisdiction_policy_rule_param_items rows. A parameter the engine does not
--     read, or of the wrong type, is refused on publication (it used to be stored and silently ignored).
--   * A history entry's detail is typed columns: a reviewer's creation names the role, a revocation its reason; a
--     policy entry's policyVersion is the policy's own id (not stored) and a seeded publication is marked.
--   * Rules, sources, overrides, parameters and publishers keep their order (the engine searches rules in order).
--   * ts_reviewers keeps the creating reviewer's role; the reviewer id is at most 40 characters (the route's rule).
--   * supersedes_id names an existing version of the same jurisdiction (checked on creation; RESTRICT).
-- Read patterns: a reviewer by id (every reviewer request) and the active administrators' count (the last-admin rule);
--   the published versions (every evaluation; decoded once per change), a version by id, every version (T&S list).
-- -----------------------------------------------------------------------------
CREATE TABLE ts_reviewers (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  name                                     TEXT NOT NULL CHECK (length(name) <= 80 AND length(name) > 0),
  role                                     TEXT NOT NULL CHECK (role IN ('trust_safety_reviewer','trust_safety_admin')),
  status                                   TEXT NOT NULL CHECK (status IN ('active','revoked')),
  secret_hash                              TEXT NOT NULL CHECK (length(secret_hash) <= 400 AND length(secret_hash) > 0),
  created_at                               INTEGER NOT NULL,
  created_by_kind                          TEXT NOT NULL CHECK (created_by_kind IN ('ts_reviewer','system')),
  created_by_id                            TEXT CHECK (created_by_id IS NULL OR length(created_by_id) <= 80 AND length(created_by_id) > 0),
  created_by_name                          TEXT CHECK (created_by_name IS NULL OR length(created_by_name) <= 200),
  created_by_role                          TEXT CHECK (created_by_role IS NULL OR length(created_by_role) <= 60 AND length(created_by_role) > 0),
  revoked_at                               INTEGER,
  revoked_by_id                            TEXT CHECK (revoked_by_id IS NULL OR length(revoked_by_id) <= 40 AND length(revoked_by_id) > 0),
  revoked_by_name                          TEXT CHECK (revoked_by_name IS NULL OR length(revoked_by_name) <= 80),
  rev                                      INTEGER NOT NULL,
  rev_at                                   INTEGER,
  rev_by_name                              TEXT CHECK (rev_by_name IS NULL OR length(rev_by_name) <= 200),
  rev_by_id                                TEXT CHECK (rev_by_id IS NULL OR length(rev_by_id) <= 80),
  FOREIGN KEY (revoked_by_id) REFERENCES ts_reviewers(id) ON DELETE RESTRICT,
  CHECK (rev >= 1),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK ((revoked_at IS NULL) = (revoked_by_id IS NULL)),
  CHECK (created_by_kind = 'ts_reviewer' OR (created_by_id IS NULL AND created_by_role IS NULL))
) STRICT;
CREATE INDEX ts_reviewers_status_role ON ts_reviewers(status, role);
CREATE TABLE ts_reviewer_history (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  reviewer_id  TEXT NOT NULL REFERENCES ts_reviewers(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  at  INTEGER NOT NULL,
  by_kind  TEXT NOT NULL CHECK (by_kind IN ('ts_reviewer','system')),
  by_id  TEXT CHECK (by_id IS NULL OR (length(by_id) > 0 AND length(by_id) <= 80)),
  by_name  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  by_role  TEXT CHECK (by_role IS NULL OR by_role IN ('trust_safety_reviewer','trust_safety_admin')),
  action  TEXT NOT NULL CHECK (action IN ('reviewer_created','reviewer_revoked')),
  detail_role  TEXT CHECK (detail_role IS NULL OR detail_role IN ('trust_safety_reviewer','trust_safety_admin')),
  detail_reason  TEXT CHECK (detail_reason IS NULL OR (length(detail_reason) > 0 AND length(detail_reason) <= 200)),
  UNIQUE (reviewer_id, ord),
  CHECK ((action = 'reviewer_created') = (detail_role IS NOT NULL)),
  CHECK (action = 'reviewer_revoked' OR detail_reason IS NULL)
) STRICT;
CREATE TABLE jurisdiction_policies (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  regulator                                TEXT NOT NULL CHECK (length(regulator) <= 20 AND length(regulator) > 0),
  jurisdiction                             TEXT NOT NULL CHECK (jurisdiction IN ('INT','ENG','USA')),
  policy_version                           INTEGER NOT NULL,
  supersedes_id                            TEXT CHECK (supersedes_id IS NULL OR length(supersedes_id) <= 80 AND length(supersedes_id) > 0),
  effective_from_date                      TEXT NOT NULL CHECK (length(effective_from_date) <= 10),
  effective_to_date                        TEXT CHECK (effective_to_date IS NULL OR length(effective_to_date) <= 10),
  status                                   TEXT NOT NULL CHECK (status IN ('proposed','published')),
  proposed_by_id                           TEXT CHECK (proposed_by_id IS NULL OR length(proposed_by_id) <= 40 AND length(proposed_by_id) > 0),
  proposed_by_name                         TEXT CHECK (proposed_by_name IS NULL OR length(proposed_by_name) <= 80),
  proposed_at                              INTEGER,
  approved_by_id                           TEXT CHECK (approved_by_id IS NULL OR length(approved_by_id) <= 40 AND length(approved_by_id) > 0),
  approved_by_name                         TEXT CHECK (approved_by_name IS NULL OR length(approved_by_name) <= 80),
  approved_at                              INTEGER,
  published_at                             INTEGER,
  created_at                               INTEGER NOT NULL,
  rev                                      INTEGER NOT NULL,
  rev_at                                   INTEGER,
  rev_by_name                              TEXT CHECK (rev_by_name IS NULL OR length(rev_by_name) <= 200),
  rev_by_id                                TEXT CHECK (rev_by_id IS NULL OR length(rev_by_id) <= 80),
  FOREIGN KEY (supersedes_id) REFERENCES jurisdiction_policies(id) ON DELETE RESTRICT,
  FOREIGN KEY (proposed_by_id) REFERENCES ts_reviewers(id) ON DELETE RESTRICT,
  FOREIGN KEY (approved_by_id) REFERENCES ts_reviewers(id) ON DELETE RESTRICT,
  CHECK (effective_from_date IS NULL OR effective_from_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  CHECK (effective_to_date IS NULL OR effective_to_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  CHECK (policy_version >= 1),
  CHECK (rev >= 1),
  CHECK (effective_to_date IS NULL OR effective_to_date > effective_from_date),
  CHECK ((status = 'published') = (published_at IS NOT NULL)),
  CHECK (status = 'published' OR approved_by_id IS NULL),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id)
) STRICT;
CREATE INDEX jurisdiction_policies_jurisdiction_status ON jurisdiction_policies(jurisdiction, status);
CREATE TABLE jurisdiction_policy_publishers (
  policy_id  TEXT NOT NULL REFERENCES jurisdiction_policies(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0 AND ord < 2),
  by_kind  TEXT NOT NULL CHECK (by_kind IN ('ts_reviewer','system')),
  by_id  TEXT NOT NULL CHECK (length(by_id) > 0 AND length(by_id) <= 80),
  by_name  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  PRIMARY KEY (policy_id, ord)
) STRICT;
CREATE TABLE jurisdiction_policy_rules (
  policy_id                                TEXT NOT NULL CHECK (length(policy_id) <= 80 AND length(policy_id) > 0),
  rule_id                                  TEXT NOT NULL CHECK (length(rule_id) <= 40 AND length(rule_id) > 0),
  ord                                      INTEGER NOT NULL,
  rule_status                              TEXT NOT NULL CHECK (rule_status IN ('ACTIVE','SUSPENDED','PARTIALLY_SUSPENDED','JURISDICTION_OVERRIDE','PENDING_IMPLEMENTATION','UNDER_LEGAL_REVIEW','UNKNOWN')),
  text_status                              TEXT CHECK (text_status IS NULL OR text_status IN ('CURRENT','CURRENT_BUT_SUSPENDED','CURRENT_WITH_PARTIAL_SUSPENSION','UNCERTAIN_OPERATIVE_STATUS','HISTORICAL','SUPERSEDED','ANNOUNCED')),
  note                                     TEXT CHECK (note IS NULL OR length(note) <= 1000 AND length(note) > 0),
  effective_from_date                      TEXT CHECK (effective_from_date IS NULL OR length(effective_from_date) <= 10),
  PRIMARY KEY (policy_id, rule_id),
  UNIQUE (policy_id, ord),
  CHECK (ord >= 0 AND ord < 200),
  CHECK (effective_from_date IS NULL OR effective_from_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  FOREIGN KEY (policy_id) REFERENCES jurisdiction_policies(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE jurisdiction_policy_rule_sources (
  policy_id                                TEXT NOT NULL CHECK (length(policy_id) <= 80 AND length(policy_id) > 0),
  rule_id                                  TEXT NOT NULL CHECK (length(rule_id) <= 40 AND length(rule_id) > 0),
  ord                                      INTEGER NOT NULL,
  source                                   TEXT NOT NULL CHECK (length(source) <= 300 AND length(source) > 0),
  version                                  TEXT CHECK (version IS NULL OR length(version) <= 120 AND length(version) > 0),
  effective_date                           TEXT CHECK (effective_date IS NULL OR length(effective_date) <= 10),
  retrieved_date                           TEXT NOT NULL CHECK (length(retrieved_date) <= 10),
  PRIMARY KEY (policy_id, rule_id, ord),
  CHECK (ord >= 0 AND ord < 20),
  CHECK (effective_date IS NULL OR effective_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  CHECK (retrieved_date IS NULL OR retrieved_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  FOREIGN KEY (policy_id, rule_id) REFERENCES jurisdiction_policy_rules(policy_id, rule_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE jurisdiction_policy_rule_overrides (
  policy_id                                TEXT NOT NULL CHECK (length(policy_id) <= 80 AND length(policy_id) > 0),
  rule_id                                  TEXT NOT NULL CHECK (length(rule_id) <= 40 AND length(rule_id) > 0),
  ord                                      INTEGER NOT NULL,
  jurisdiction                             TEXT NOT NULL CHECK (jurisdiction IN ('INT','ENG','USA')),
  scope                                    TEXT NOT NULL CHECK (scope IN ('national')),
  override_rule_id                         TEXT NOT NULL CHECK (length(override_rule_id) <= 40 AND length(override_rule_id) > 0),
  PRIMARY KEY (policy_id, rule_id, ord),
  UNIQUE (policy_id, rule_id, jurisdiction),
  CHECK (ord >= 0 AND ord < 10),
  FOREIGN KEY (policy_id, rule_id) REFERENCES jurisdiction_policy_rules(policy_id, rule_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE jurisdiction_policy_rule_params (
  policy_id  TEXT NOT NULL,
  rule_id  TEXT NOT NULL,
  name  TEXT NOT NULL CHECK (name IN ('licenceRequired','licenceHolder','onlyLicensedAgentPerforms','agencyStaffMayNotApproach','onlyLicensedAgentApproaches','maxTermMonthsIndividual','oneAgreementPerPair','legalAdviceNotice','permittedSets','consentKind','consentInAdvance','prohibitedWith','connectedAgentsAreOne','sameAgencyConnected','formula','firstContractAge','guardianConsentBeforeApproach','minorsAccreditationRequired','validityYears','informational','noFeeForMinorWithoutProContract','otherServicesPresumptionMonths','exclusivityWindowMonths','discloseConflicts','effectiveFrom','nationalRegistrationRequired','requiresFifaLicence','cascadeFromFifaLicence','onlyRegisteredAgentPerforms','agencyPartyColleaguePerformance','productionEnabled','pendingLegalReview','pfaLmaNotice','academicYearStart','coversIndirectApproach','minorsAuthorisationRequired','enhancedDbsWithinMonths','permittedMultiple','excludedRole','fullParticularsRequired','legalAdviceOfferRequired','prescribedForm','activeLimbs','lodgeWithinDays','domesticAuthorisationRequired','kind')),
  ord  INTEGER NOT NULL CHECK (ord >= 0 AND ord < 46),
  flag_value  INTEGER CHECK (flag_value IS NULL OR flag_value IN (0,1)),
  count_value  INTEGER CHECK (count_value IS NULL OR count_value >= 0),
  text_value  TEXT CHECK (text_value IS NULL OR (length(text_value) > 0 AND length(text_value) <= 200)),
  PRIMARY KEY (policy_id, rule_id, name),
  UNIQUE (policy_id, rule_id, ord),
  CHECK ((flag_value IS NOT NULL) + (count_value IS NOT NULL) + (text_value IS NOT NULL) <= 1),
  FOREIGN KEY (policy_id, rule_id) REFERENCES jurisdiction_policy_rules(policy_id, rule_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE jurisdiction_policy_rule_param_items (
  policy_id  TEXT NOT NULL,
  rule_id  TEXT NOT NULL,
  name  TEXT NOT NULL,
  set_no  INTEGER NOT NULL CHECK (set_no >= 0),
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  member  TEXT CHECK (member IS NULL OR (length(member) = 3 AND member GLOB '[A-Z][A-Z][A-Z]')),
  count_value  INTEGER CHECK (count_value IS NULL OR count_value >= 0),
  text_value  TEXT CHECK (text_value IS NULL OR (length(text_value) > 0 AND length(text_value) <= 200)),
  PRIMARY KEY (policy_id, rule_id, name, set_no, ord),
  CHECK ((member IS NULL) = (count_value IS NULL)),
  CHECK ((member IS NULL) <> (text_value IS NULL)),
  FOREIGN KEY (policy_id, rule_id, name) REFERENCES jurisdiction_policy_rule_params(policy_id, rule_id, name) ON DELETE CASCADE
) STRICT;
CREATE TABLE jurisdiction_policy_history (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  policy_id  TEXT NOT NULL REFERENCES jurisdiction_policies(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  at  INTEGER NOT NULL,
  by_kind  TEXT NOT NULL CHECK (by_kind IN ('ts_reviewer','system')),
  by_id  TEXT CHECK (by_id IS NULL OR (length(by_id) > 0 AND length(by_id) <= 80)),
  by_name  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  by_role  TEXT CHECK (by_role IS NULL OR by_role IN ('trust_safety_reviewer','trust_safety_admin')),
  action  TEXT NOT NULL CHECK (action IN ('policy_version_proposed','policy_version_published')),
  detail_seeded  INTEGER NOT NULL DEFAULT 0 CHECK (detail_seeded IN (0,1)),
  UNIQUE (policy_id, ord),
  CHECK (detail_seeded = 0 OR (action = 'policy_version_published' AND by_kind = 'system'))
) STRICT;


-- -----------------------------------------------------------------------------
-- S11a: IMPLEMENTED, migration 0026_agent_core REGISTERED (repositories/agentCore.mjs, 5 Nov 2026).
-- The definitions below are the migration's DDL (generated from the repository's field specs, like S10a–S10c);
-- scripts/testSchemaDdl.mjs compares them column by column.
-- Sources: domains/agents/core/ (profiles, facets, affiliations, agreements, opportunity shares, agency settings);
-- domains/agents/compliance/ (facet rechecks and review decisions write a profile's facet or an agreement's status).
-- How the model differs from the first draft of this file:
--   * No JSON columns. A history entry's detail is typed columns, by action (a facet change names the facet, member
--     association and states; an affiliation change its roles, as rows; an agreement change its statuses, side,
--     reason code or review). A request's scope, term and policy versions are read from the agreement itself.
--   * Idempotency keys are columns of their owner (key + fp), not rows of a shared table: an affiliation's create; an
--     agreement's request, confirm, decline, client terminate, dispute and agent terminate; a share's share.
--   * A facet is one row per (profile, facet, member association); the FIFA licence is stored under 'INT'.
--     agent_profile_declared_jurisdictions is agent_profile_jurisdictions (ordered).
--   * policy_version (profiles, agreements) and is_regulatory_minor are not stored (constants of this build).
--   * agreement_documents is gone with the legacy M13 F10 lane (S11a): no route wrote one.
--   * The client's three disclosure choices are columns of the agreement.
--   * org_agency_settings.org_id is RESTRICT, like every organisation key; the retired orgs.agencySettings facet is
--     removed from facets_json by the migration.
--   * Staff ids (org_users) and agencies (orgs) are immediate RESTRICT keys; a client (player) id carries no key
--     (tolerant, as recruitment: an agreement outlives an account deletion as an id-only tombstone).
-- Read patterns: a profile by user; affiliations by (user, agency) [every agent request] and active ones by agency
--   [team, bootstrap]; agreements by id, by client [player lists, sole active agent] and by agent or agency [client
--   lists]; an agency's settings by organisation.
-- -----------------------------------------------------------------------------
CREATE TABLE agent_profiles (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  user_id                                  TEXT NOT NULL CHECK (length(user_id) <= 80 AND length(user_id) > 0),
  agency_org_id                            TEXT NOT NULL CHECK (length(agency_org_id) <= 80 AND length(agency_org_id) > 0),
  display_name                             TEXT NOT NULL CHECK (length(display_name) <= 80 AND length(display_name) > 0),
  created_at                               INTEGER NOT NULL,
  updated_at                               INTEGER NOT NULL,
  rev                                      INTEGER NOT NULL,
  rev_at                                   INTEGER,
  rev_by_name                              TEXT CHECK (rev_by_name IS NULL OR length(rev_by_name) <= 200),
  rev_by_id                                TEXT CHECK (rev_by_id IS NULL OR length(rev_by_id) <= 80),
  declared_fifa_licence_number             TEXT CHECK (declared_fifa_licence_number IS NULL OR length(declared_fifa_licence_number) <= 40 AND length(declared_fifa_licence_number) > 0),
  FOREIGN KEY (user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (agency_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  UNIQUE (user_id),
  CHECK (rev >= 1)
) STRICT;
CREATE INDEX agent_profiles_agency ON agent_profiles (agency_org_id);
CREATE TABLE agent_profile_jurisdictions (
  profile_id    TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL CHECK (ord >= 0),
  jurisdiction  TEXT NOT NULL CHECK (jurisdiction IN ('INT','ENG','USA')),
  PRIMARY KEY (profile_id, jurisdiction),
  UNIQUE (profile_id, ord)
) STRICT;
CREATE TABLE agent_profile_facets (
  profile_id                               TEXT NOT NULL CHECK (length(profile_id) <= 80 AND length(profile_id) > 0),
  facet                                    TEXT NOT NULL CHECK (facet IN ('fifa_licence','national_registration','domestic_authorisation','minors_authorisation')),
  member_association                       TEXT NOT NULL CHECK (member_association IN ('INT','ENG','USA')),
  state                                    TEXT NOT NULL CHECK (state IN ('UNVERIFIED','PENDING','VERIFIED','STALE','INACTIVE','MANUAL_REVIEW_REQUIRED')),
  reference                                TEXT CHECK (reference IS NULL OR length(reference) <= 60 AND length(reference) > 0),
  provenance_provider                      TEXT CHECK (provenance_provider IS NULL OR provenance_provider IN ('none','local-synthetic-test-provider','attributed_review')),
  provenance_kind                          TEXT CHECK (provenance_kind IS NULL OR provenance_kind IN ('none','synthetic','human_review')),
  provenance_at                            INTEGER,
  provenance_reviewer_id                   TEXT CHECK (provenance_reviewer_id IS NULL OR length(provenance_reviewer_id) <= 80 AND length(provenance_reviewer_id) > 0),
  provenance_review_id                     TEXT CHECK (provenance_review_id IS NULL OR length(provenance_review_id) <= 80 AND length(provenance_review_id) > 0),
  submitted_at                             INTEGER,
  verified_at                              INTEGER,
  recheck_at                               INTEGER,
  note                                     TEXT CHECK (note IS NULL OR length(note) <= 1000),
  stale_notified_at                        INTEGER,
  FOREIGN KEY (profile_id) REFERENCES agent_profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, facet, member_association),
  CHECK ((facet = 'fifa_licence') = (member_association = 'INT')),
  CHECK (provenance_reviewer_id IS NULL OR provenance_provider = 'attributed_review')
) STRICT;
CREATE INDEX agent_profile_facets_stale ON agent_profile_facets (recheck_at) WHERE state = 'VERIFIED' AND stale_notified_at IS NULL AND recheck_at IS NOT NULL;
CREATE TABLE agent_profile_history (
  id                    TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  profile_id            TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  ord                   INTEGER NOT NULL CHECK (ord >= 0),
  at                    INTEGER NOT NULL,
  by_kind               TEXT NOT NULL CHECK (by_kind IN ('org','player','ts_reviewer','system')),
  by_id                 TEXT CHECK (by_id IS NULL OR (length(by_id) > 0 AND length(by_id) <= 80)),
  by_name               TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  by_role               TEXT CHECK (by_role IS NULL OR length(by_role) <= 60),
  action                TEXT NOT NULL CHECK (action IN ('agent_profile_created','agent_profile_updated','agent_verification_submitted','agent_verification_state_changed','agent_facet_rechecked')),
  detail_display_name   INTEGER CHECK (detail_display_name IN (0,1)),
  detail_jurisdictions  INTEGER CHECK (detail_jurisdictions IN (0,1)),
  detail_licence_number INTEGER CHECK (detail_licence_number IN (0,1)),
  detail_facet          TEXT CHECK (detail_facet IS NULL OR detail_facet IN ('fifa_licence','national_registration','domestic_authorisation','minors_authorisation')),
  detail_ma             TEXT CHECK (detail_ma IS NULL OR detail_ma IN ('INT','ENG','USA')),
  detail_from TEXT CHECK (detail_from IS NULL OR detail_from IN ('UNVERIFIED','PENDING','VERIFIED','STALE','INACTIVE','MANUAL_REVIEW_REQUIRED')),
  detail_to TEXT CHECK (detail_to IS NULL OR detail_to IN ('UNVERIFIED','PENDING','VERIFIED','STALE','INACTIVE','MANUAL_REVIEW_REQUIRED')),
  detail_state TEXT CHECK (detail_state IS NULL OR detail_state IN ('UNVERIFIED','PENDING','VERIFIED','STALE','INACTIVE','MANUAL_REVIEW_REQUIRED')),
  detail_review_id      TEXT CHECK (detail_review_id IS NULL OR (length(detail_review_id) > 0 AND length(detail_review_id) <= 80)),
  UNIQUE (profile_id, ord),
  CHECK ((action = 'agent_profile_updated') = (detail_display_name IS NOT NULL)),
  CHECK ((detail_display_name IS NULL) = (detail_jurisdictions IS NULL) AND (detail_display_name IS NULL) = (detail_licence_number IS NULL)),
  CHECK ((action IN ('agent_verification_submitted','agent_verification_state_changed','agent_facet_rechecked')) = (detail_facet IS NOT NULL)),
  CHECK ((action IN ('agent_verification_state_changed','agent_facet_rechecked')) = (detail_to IS NOT NULL)),
  CHECK ((detail_from IS NULL) = (detail_to IS NULL)),
  CHECK ((action = 'agent_verification_state_changed') = (detail_state IS NOT NULL)),
  CHECK (detail_review_id IS NULL OR action = 'agent_verification_state_changed')
) STRICT;
CREATE TABLE agency_affiliations (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  agency_org_id                            TEXT NOT NULL CHECK (length(agency_org_id) <= 80 AND length(agency_org_id) > 0),
  user_id                                  TEXT NOT NULL CHECK (length(user_id) <= 80 AND length(user_id) > 0),
  started_at                               INTEGER NOT NULL,
  ended_at                                 INTEGER,
  ended_reason                             TEXT CHECK (ended_reason IS NULL OR length(ended_reason) <= 40),
  created_at                               INTEGER NOT NULL,
  rev                                      INTEGER NOT NULL,
  rev_at                                   INTEGER,
  rev_by_name                              TEXT CHECK (rev_by_name IS NULL OR length(rev_by_name) <= 200),
  rev_by_id                                TEXT CHECK (rev_by_id IS NULL OR length(rev_by_id) <= 80),
  create_key                               TEXT CHECK (create_key IS NULL OR length(create_key) <= 64 AND length(create_key) > 0),
  create_fp                                TEXT CHECK (create_fp IS NULL OR length(create_fp) <= 4000),
  FOREIGN KEY (agency_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK (rev >= 1),
  CHECK (ended_at IS NULL OR ended_reason IS NOT NULL),
  CHECK ((create_key IS NULL) = (create_fp IS NULL))
) STRICT;
CREATE INDEX agency_affiliations_member ON agency_affiliations (user_id, agency_org_id);
CREATE INDEX agency_affiliations_agency ON agency_affiliations (agency_org_id, ended_at);
CREATE UNIQUE INDEX agency_affiliations_create_key ON agency_affiliations (agency_org_id, create_key) WHERE create_key IS NOT NULL;
CREATE TABLE agency_affiliation_tiers (
  affiliation_id  TEXT NOT NULL REFERENCES agency_affiliations(id) ON DELETE CASCADE,
  ord             INTEGER NOT NULL CHECK (ord >= 0),
  tier            TEXT NOT NULL CHECK (tier IN ('licensed_agent','agency_admin','analyst','assistant','finance')),
  PRIMARY KEY (affiliation_id, tier),
  UNIQUE (affiliation_id, ord)
) STRICT;
CREATE TABLE agency_affiliation_history (
  id                    TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  affiliation_id        TEXT NOT NULL REFERENCES agency_affiliations(id) ON DELETE CASCADE,
  ord                   INTEGER NOT NULL CHECK (ord >= 0),
  at                    INTEGER NOT NULL,
  by_kind               TEXT NOT NULL CHECK (by_kind IN ('org','player','ts_reviewer','system')),
  by_id                 TEXT CHECK (by_id IS NULL OR (length(by_id) > 0 AND length(by_id) <= 80)),
  by_name               TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  by_role               TEXT CHECK (by_role IS NULL OR length(by_role) <= 60),
  action                TEXT NOT NULL CHECK (action IN ('agency_affiliation_created','agency_affiliation_updated','agency_affiliation_ended')),
  detail_bootstrap      INTEGER CHECK (detail_bootstrap IN (1)),
  detail_reason_code    TEXT CHECK (detail_reason_code IS NULL OR length(detail_reason_code) <= 40),
  UNIQUE (affiliation_id, ord),
  CHECK (detail_bootstrap IS NULL OR action = 'agency_affiliation_created'),
  CHECK ((action = 'agency_affiliation_ended') = (detail_reason_code IS NOT NULL))
) STRICT;
CREATE TABLE agency_affiliation_history_tiers (
  history_id  TEXT NOT NULL REFERENCES agency_affiliation_history(id) ON DELETE CASCADE,
  list        TEXT NOT NULL CHECK (list IN ('from','to')),
  ord         INTEGER NOT NULL CHECK (ord >= 0),
  tier        TEXT NOT NULL CHECK (tier IN ('licensed_agent','agency_admin','analyst','assistant','finance')),
  PRIMARY KEY (history_id, list, ord)
) STRICT;
CREATE TABLE representation_agreements (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  agent_user_id                            TEXT NOT NULL CHECK (length(agent_user_id) <= 80 AND length(agent_user_id) > 0),
  agency_org_id                            TEXT NOT NULL CHECK (length(agency_org_id) <= 80 AND length(agency_org_id) > 0),
  client_kind                              TEXT NOT NULL CHECK (client_kind IN ('player')),
  client_id                                TEXT NOT NULL CHECK (length(client_id) <= 80 AND length(client_id) > 0),
  jurisdiction                             TEXT NOT NULL CHECK (jurisdiction IN ('INT','ENG','USA')),
  exclusive                                INTEGER NOT NULL CHECK (exclusive IN (0,1)),
  term_months                              INTEGER NOT NULL,
  start_at                                 INTEGER,
  end_at                                   INTEGER,
  status                                   TEXT NOT NULL CHECK (status IN ('proposed','active','declined','terminated_by_client','terminated_by_agent','disputed')),
  proposed_at                              INTEGER NOT NULL,
  confirmed_at                             INTEGER,
  declined_at                              INTEGER,
  terminated_at                            INTEGER,
  terminated_by                            TEXT CHECK (terminated_by IS NULL OR terminated_by IN ('agent','client','trust_safety')),
  termination_reason_code                  TEXT CHECK (termination_reason_code IS NULL OR length(termination_reason_code) <= 40),
  disputed_at                              INTEGER,
  dispute_reason                           TEXT CHECK (dispute_reason IS NULL OR length(dispute_reason) <= 300),
  dispute_resolved_at                      INTEGER,
  dispute_review_id                        TEXT CHECK (dispute_review_id IS NULL OR length(dispute_review_id) <= 80 AND length(dispute_review_id) > 0),
  dispute_outcome                          TEXT CHECK (dispute_outcome IS NULL OR dispute_outcome IN ('reinstated','ended')),
  share_with_agency_staff                  INTEGER NOT NULL CHECK (share_with_agency_staff IN (0,1)),
  disclosure_club_presence                 INTEGER NOT NULL CHECK (disclosure_club_presence IN (0,1)),
  disclosure_contact_routing               INTEGER NOT NULL CHECK (disclosure_contact_routing IN (0,1)),
  disclosure_trial_visibility              INTEGER NOT NULL CHECK (disclosure_trial_visibility IN (0,1)),
  subject_removed_at                       INTEGER,
  expiry_notified_at                       INTEGER,
  created_at                               INTEGER NOT NULL,
  rev                                      INTEGER NOT NULL,
  rev_at                                   INTEGER,
  rev_by_name                              TEXT CHECK (rev_by_name IS NULL OR length(rev_by_name) <= 200),
  rev_by_id                                TEXT CHECK (rev_by_id IS NULL OR length(rev_by_id) <= 80),
  confirmed_by_player_id                   TEXT CHECK (confirmed_by_player_id IS NULL OR length(confirmed_by_player_id) <= 80 AND length(confirmed_by_player_id) > 0),
  request_key                              TEXT CHECK (request_key IS NULL OR length(request_key) <= 64 AND length(request_key) > 0),
  request_fp                               TEXT CHECK (request_fp IS NULL OR length(request_fp) <= 4000),
  confirm_key                              TEXT CHECK (confirm_key IS NULL OR length(confirm_key) <= 64 AND length(confirm_key) > 0),
  confirm_fp                               TEXT CHECK (confirm_fp IS NULL OR length(confirm_fp) <= 4000),
  decline_key                              TEXT CHECK (decline_key IS NULL OR length(decline_key) <= 64 AND length(decline_key) > 0),
  decline_fp                               TEXT CHECK (decline_fp IS NULL OR length(decline_fp) <= 4000),
  client_terminate_key                     TEXT CHECK (client_terminate_key IS NULL OR length(client_terminate_key) <= 64 AND length(client_terminate_key) > 0),
  client_terminate_fp                      TEXT CHECK (client_terminate_fp IS NULL OR length(client_terminate_fp) <= 4000),
  dispute_key                              TEXT CHECK (dispute_key IS NULL OR length(dispute_key) <= 64 AND length(dispute_key) > 0),
  dispute_fp                               TEXT CHECK (dispute_fp IS NULL OR length(dispute_fp) <= 4000),
  agent_terminate_key                      TEXT CHECK (agent_terminate_key IS NULL OR length(agent_terminate_key) <= 64 AND length(agent_terminate_key) > 0),
  agent_terminate_fp                       TEXT CHECK (agent_terminate_fp IS NULL OR length(agent_terminate_fp) <= 4000),
  FOREIGN KEY (agent_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (agency_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  CHECK (term_months BETWEEN 1 AND 24),
  CHECK (rev >= 1),
  CHECK ((confirmed_at IS NULL) = (confirmed_by_player_id IS NULL)),
  CHECK ((status = 'declined') = (declined_at IS NOT NULL)),
  CHECK ((terminated_at IS NULL) = (terminated_by IS NULL)),
  CHECK (status NOT IN ('terminated_by_client','terminated_by_agent') OR terminated_at IS NOT NULL),
  CHECK (status <> 'disputed' OR disputed_at IS NOT NULL),
  CHECK ((dispute_resolved_at IS NULL) = (dispute_review_id IS NULL)),
  CHECK ((request_key IS NULL) = (request_fp IS NULL)),
  CHECK ((confirm_key IS NULL) = (confirm_fp IS NULL)),
  CHECK ((decline_key IS NULL) = (decline_fp IS NULL)),
  CHECK ((client_terminate_key IS NULL) = (client_terminate_fp IS NULL)),
  CHECK ((dispute_key IS NULL) = (dispute_fp IS NULL)),
  CHECK ((agent_terminate_key IS NULL) = (agent_terminate_fp IS NULL))
) STRICT;
CREATE INDEX representation_agreements_agency_agent ON representation_agreements (agency_org_id, agent_user_id);
CREATE INDEX representation_agreements_client ON representation_agreements (client_id);
CREATE INDEX representation_agreements_expiry ON representation_agreements (end_at) WHERE status = 'active' AND expiry_notified_at IS NULL AND end_at IS NOT NULL;
CREATE UNIQUE INDEX representation_agreements_request_key ON representation_agreements (agency_org_id, agent_user_id, request_key) WHERE request_key IS NOT NULL;
CREATE TABLE agreement_scopes (
  agreement_id  TEXT NOT NULL REFERENCES representation_agreements(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL CHECK (ord >= 0),
  scope         TEXT NOT NULL CHECK (scope IN ('employment','transfer','commercial','other_services')),
  PRIMARY KEY (agreement_id, scope),
  UNIQUE (agreement_id, ord)
) STRICT;
CREATE TABLE agreement_policy_versions (
  agreement_id       TEXT NOT NULL REFERENCES representation_agreements(id) ON DELETE CASCADE,
  ord                INTEGER NOT NULL CHECK (ord >= 0),
  policy_version_id  TEXT NOT NULL CHECK (length(policy_version_id) > 0 AND length(policy_version_id) <= 80),
  PRIMARY KEY (agreement_id, policy_version_id),
  UNIQUE (agreement_id, ord)
) STRICT;
CREATE TABLE agreement_opportunity_shares (
  agreement_id                             TEXT NOT NULL CHECK (length(agreement_id) <= 80 AND length(agreement_id) > 0),
  ord                                      INTEGER NOT NULL,
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  opportunity_id                           TEXT NOT NULL CHECK (length(opportunity_id) <= 80 AND length(opportunity_id) > 0),
  via                                      TEXT CHECK (via IS NULL OR via IN ('opportunity','open_trial')),
  title                                    TEXT CHECK (title IS NULL OR length(title) <= 200),
  org_name                                 TEXT CHECK (org_name IS NULL OR length(org_name) <= 200),
  deadline                                 TEXT CHECK (deadline IS NULL OR length(deadline) <= 40),
  note                                     TEXT CHECK (note IS NULL OR length(note) <= 300 AND length(note) > 0),
  shared_at                                INTEGER NOT NULL,
  shared_by_kind                           TEXT NOT NULL CHECK (shared_by_kind IN ('org')),
  shared_by_user_id                        TEXT NOT NULL CHECK (length(shared_by_user_id) <= 80 AND length(shared_by_user_id) > 0),
  shared_by_name                           TEXT CHECK (shared_by_name IS NULL OR length(shared_by_name) <= 200),
  withdrawn_at                             INTEGER,
  rev                                      INTEGER NOT NULL,
  rev_at                                   INTEGER NOT NULL,
  share_key                                TEXT CHECK (share_key IS NULL OR length(share_key) <= 64 AND length(share_key) > 0),
  share_fp                                 TEXT CHECK (share_fp IS NULL OR length(share_fp) <= 4000),
  FOREIGN KEY (agreement_id) REFERENCES representation_agreements(id) ON DELETE CASCADE,
  FOREIGN KEY (shared_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  UNIQUE (agreement_id, ord),
  CHECK (ord >= 0 AND ord < 200),
  CHECK (rev >= 1),
  CHECK ((share_key IS NULL) = (share_fp IS NULL))
) STRICT;
CREATE UNIQUE INDEX agreement_opportunity_shares_live ON agreement_opportunity_shares (agreement_id, opportunity_id) WHERE withdrawn_at IS NULL;
CREATE UNIQUE INDEX agreement_opportunity_shares_key ON agreement_opportunity_shares (agreement_id, share_key) WHERE share_key IS NOT NULL;
CREATE TABLE agreement_history (
  id                              TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  agreement_id                    TEXT NOT NULL REFERENCES representation_agreements(id) ON DELETE CASCADE,
  ord                             INTEGER NOT NULL CHECK (ord >= 0),
  at                              INTEGER NOT NULL,
  by_kind                         TEXT NOT NULL CHECK (by_kind IN ('org','player','ts_reviewer','system')),
  by_id                           TEXT CHECK (by_id IS NULL OR (length(by_id) > 0 AND length(by_id) <= 80)),
  by_name                         TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  by_role                         TEXT CHECK (by_role IS NULL OR length(by_role) <= 60),
  action                          TEXT NOT NULL CHECK (action IN ('representation_requested','representation_confirmed','representation_rejected','representation_terminated','representation_disputed','representation_sharing_changed','opportunity_shared','opportunity_share_withdrawn')),
  detail_by                       TEXT CHECK (detail_by IS NULL OR detail_by IN ('agent','client','trust_safety')),
  detail_from TEXT CHECK (detail_from IS NULL OR detail_from IN ('proposed','active','declined','expired','terminated_by_client','terminated_by_agent','disputed')),
  detail_to TEXT CHECK (detail_to IS NULL OR detail_to IN ('proposed','active','declined','expired','terminated_by_client','terminated_by_agent','disputed')),
  detail_had_reason               INTEGER CHECK (detail_had_reason IN (0,1)),
  detail_phase TEXT CHECK (detail_phase IS NULL OR detail_phase IN ('proposed','active','declined','expired','terminated_by_client','terminated_by_agent','disputed')),
  detail_reason_code              TEXT CHECK (detail_reason_code IS NULL OR length(detail_reason_code) <= 40),
  detail_review_id                TEXT CHECK (detail_review_id IS NULL OR (length(detail_review_id) > 0 AND length(detail_review_id) <= 80)),
  detail_share_with_agency_staff  INTEGER CHECK (detail_share_with_agency_staff IN (0,1)),
  detail_club_presence            INTEGER CHECK (detail_club_presence IN (0,1)),
  detail_contact_routing          INTEGER CHECK (detail_contact_routing IN (0,1)),
  detail_trial_visibility         INTEGER CHECK (detail_trial_visibility IN (0,1)),
  detail_share_id                 TEXT CHECK (detail_share_id IS NULL OR (length(detail_share_id) > 0 AND length(detail_share_id) <= 80)),
  detail_via                      TEXT CHECK (detail_via IS NULL OR detail_via IN ('opportunity','open_trial')),
  UNIQUE (agreement_id, ord),
  CHECK ((action IN ('representation_confirmed','representation_rejected','representation_terminated','representation_disputed')) = (detail_by IS NOT NULL)),
  CHECK ((detail_by = 'client') = (detail_from IS NOT NULL AND detail_to IS NOT NULL AND detail_had_reason IS NOT NULL)),
  CHECK (detail_by IS NULL OR detail_by = 'client' OR (detail_phase IS NOT NULL AND detail_reason_code IS NOT NULL)),
  CHECK ((detail_by = 'trust_safety') = (detail_review_id IS NOT NULL)),
  CHECK ((action IN ('opportunity_shared','opportunity_share_withdrawn')) = (detail_share_id IS NOT NULL)),
  CHECK (detail_via IS NULL OR action = 'opportunity_shared'),
  CHECK ((action = 'representation_sharing_changed') = (coalesce(detail_share_with_agency_staff, detail_club_presence, detail_contact_routing, detail_trial_visibility) IS NOT NULL))
) STRICT;
CREATE TABLE org_agency_settings (
  org_id       TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE RESTRICT,
  description  TEXT NOT NULL CHECK (length(description) <= 300),
  updated_at   INTEGER NOT NULL
) STRICT;
CREATE TABLE org_agency_jurisdictions (
  org_id        TEXT NOT NULL REFERENCES org_agency_settings(org_id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL CHECK (ord >= 0),
  jurisdiction  TEXT NOT NULL CHECK (jurisdiction IN ('INT','ENG','USA')),
  PRIMARY KEY (org_id, jurisdiction),
  UNIQUE (org_id, ord)
) STRICT;


-- -----------------------------------------------------------------------------
-- S11b-2: IMPLEMENTED, migration 0028_compliance_records REGISTERED (repositories/complianceRecords.mjs, 5 Nov 2026).
-- The definitions below are the migration's DDL; scripts/testSchemaDdl.mjs compares them column by column.
-- Sources: domains/agents/compliance/index.mjs (contexts, evaluations, reviews, consents; the transaction seam opens,
-- projects, evaluates and closes a transaction's context); domains/agents/core/index.mjs (a facet or a dispute raises
-- a review through the hooks).
-- How the model differs from the first draft of this file:
--   * No JSON columns. A review's subject is typed columns by kind (the facet subject's "referenceHash", which held the
--     reference's length, is gone). Its snapshot is the outcome at request time and the evaluation row it was taken
--     from (snapshot_evaluation_id), never a copy; an Approach item, which has no context, keeps the outcome and instant.
--     The decision's prior and resulting state are columns (prior_* / result_*, with result_note for a subject that
--     is gone). An evaluation's identity of inputs is two child tables and the proposed representation two columns.
--   * A reason's extras (facet, member association, state, agent, party role, consent kind, detail, override,
--     connected-agent attribution) are columns; its party-role and jurisdiction lists are *_reason_items rows.
--   * History details are typed columns or worked out from their record: a review's request, resolution and
--     cancellation repeat the review; a consent's entries repeat the consent; an evaluation entry names its row.
--   * Idempotency keys are columns of their owner (key + fp), not rows of a shared table.
--   * A revocation keeps only its own facts (id, instant, actor); the consent it revokes is UNIQUE (revoked once).
--   * Dead fields are gone: a context's otherServices and interests (no route wrote either), the revocation's copy of
--     its consent's fields and its second history entry; alias, required actions, missing evidence and rule statuses
--     are worked out on read.
--   * Every key is immediate RESTRICT (a child row's CASCADE): agencies, staff, reviewers, policy versions,
--     agreements, profiles and, within the domain, a review's context, evaluation and supersession, a representation's
--     review and a consent's context. A party's, a consent's and an Approach item's player or club carries no key.
-- Read patterns: contexts by agent, by create key, open ones of an agency (connected agents), open ones of a
--   jurisdiction whose latest evaluation predates a version (policy publication); reviews by subject (one open item
--   per facet or agreement), by context, by agency, the T&S queue (open first, by cursor), metrics, the newest
--   decision entries; consents by context, by subject, by agent, by request key, metrics.
-- -----------------------------------------------------------------------------
CREATE TABLE compliance_contexts (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  agency_org_id  TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  agent_user_id  TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  type  TEXT NOT NULL CHECK (type IN ('employment_contract','transfer','loan','other_services')),
  status  TEXT NOT NULL CHECK (status IN ('open','closed')),
  re_evaluation_pending  INTEGER NOT NULL CHECK (re_evaluation_pending IN (0,1)),
  review_rejected_at  INTEGER,
  origin  TEXT CHECK (origin IS NULL OR origin = 'transaction'),
  transaction_id  TEXT CHECK (transaction_id IS NULL OR (length(transaction_id) > 0 AND length(transaction_id) <= 80)),
  opened_at  INTEGER NOT NULL,
  closed_at  INTEGER,
  create_key  TEXT CHECK (create_key IS NULL OR (length(create_key) > 0 AND length(create_key) <= 64)),
  create_fp  TEXT CHECK ((create_fp IS NULL OR length(create_fp) <= 4000) AND ((create_key IS NULL) = (create_fp IS NULL))),
  rev  INTEGER NOT NULL CHECK (rev >= 1),
  rev_at  INTEGER,
  rev_by_id  TEXT CHECK (rev_by_id IS NULL OR (length(rev_by_id) > 0 AND length(rev_by_id) <= 80)),
  rev_by_name  TEXT CHECK (rev_by_name IS NULL OR length(rev_by_name) <= 200),
  CHECK ((origin IS NULL) = (transaction_id IS NULL)),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
) STRICT;
CREATE INDEX compliance_contexts_agent ON compliance_contexts(agency_org_id, agent_user_id);
CREATE INDEX compliance_contexts_open ON compliance_contexts(agency_org_id) WHERE status = 'open';
CREATE UNIQUE INDEX compliance_contexts_transaction ON compliance_contexts(transaction_id) WHERE transaction_id IS NOT NULL;
CREATE UNIQUE INDEX compliance_contexts_create_key ON compliance_contexts(agency_org_id, agent_user_id, create_key) WHERE create_key IS NOT NULL;
CREATE TABLE compliance_context_jurisdictions (
  context_id  TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0 AND ord < 10),
  member_association  TEXT NOT NULL CHECK (member_association GLOB '[A-Z][A-Z][A-Z]'),
  PRIMARY KEY (context_id, ord),
  UNIQUE (context_id, member_association)
) STRICT;
CREATE INDEX compliance_context_jurisdictions_ma ON compliance_context_jurisdictions(member_association);
CREATE TABLE compliance_context_parties (
  context_id  TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  id  TEXT NOT NULL CHECK ((length(id) > 0 AND length(id) <= 80)),
  party_role  TEXT NOT NULL CHECK (party_role IN ('individual','engaging_entity','releasing_entity')),
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('player','club')),
  subject_id  TEXT NOT NULL CHECK ((length(subject_id) > 0 AND length(subject_id) <= 80)),
  added_at  INTEGER,
  removed  INTEGER NOT NULL CHECK (removed IN (0,1)),
  removed_at  INTEGER,
  PRIMARY KEY (context_id, id),
  UNIQUE (context_id, ord),
  CHECK (removed = 1 OR removed_at IS NULL)
) STRICT;
CREATE INDEX compliance_context_parties_subject ON compliance_context_parties(subject_kind, subject_id);
CREATE TABLE compliance_context_representations (
  context_id  TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  id  TEXT NOT NULL CHECK ((length(id) > 0 AND length(id) <= 80)),
  agent_user_id  TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  party_role  TEXT NOT NULL CHECK (party_role IN ('individual','engaging_entity','releasing_entity')),
  agreement_id  TEXT REFERENCES representation_agreements(id) ON DELETE RESTRICT,
  status  TEXT NOT NULL CHECK (status IN ('verified','pending_review','withdrawn')),
  declared_only  INTEGER NOT NULL CHECK (declared_only IN (0,1)),
  review_id  TEXT REFERENCES regulatory_reviews(id) ON DELETE RESTRICT,
  declared_at  INTEGER,
  first_act_at  INTEGER,
  withdrawn_at  INTEGER,
  verified_by_review_id  TEXT REFERENCES regulatory_reviews(id) ON DELETE RESTRICT,
  verified_at  INTEGER,
  declare_key  TEXT CHECK (declare_key IS NULL OR (length(declare_key) > 0 AND length(declare_key) <= 64)),
  declare_fp  TEXT CHECK ((declare_fp IS NULL OR length(declare_fp) <= 4000) AND ((declare_key IS NULL) = (declare_fp IS NULL))),
  PRIMARY KEY (context_id, id),
  UNIQUE (context_id, ord)
) STRICT;
CREATE TABLE compliance_context_resolved_facts (
  context_id  TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  code  TEXT NOT NULL CHECK (code IN ('OTHER_SERVICES_PRESUMPTION','INTEREST_DECLARED','REPRESENTATION_UNVERIFIED')),
  PRIMARY KEY (context_id, ord),
  UNIQUE (context_id, code)
) STRICT;
CREATE TABLE compliance_evaluations (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 100),
  context_id  TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL CHECK (position >= 1),
  outcome  TEXT NOT NULL CHECK (outcome IN ('CLEAR','PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED','PROHIBITED_CONFLICT','MANUAL_REGULATORY_REVIEW_REQUIRED','INSUFFICIENT_DATA')),
  evaluated_at  INTEGER NOT NULL,
  input_hash  TEXT NOT NULL CHECK (length(input_hash) = 64),
  proposed_party_role  TEXT CHECK (proposed_party_role IS NULL OR proposed_party_role IN ('individual','engaging_entity','releasing_entity')),
  proposed_agent_user_id  TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  UNIQUE (context_id, position),
  CHECK (id = context_id || '#' || position),
  CHECK ((proposed_party_role IS NULL) = (proposed_agent_user_id IS NULL))
) STRICT;
CREATE INDEX compliance_evaluations_outcome ON compliance_evaluations(outcome);
CREATE TABLE compliance_evaluation_reasons (
  evaluation_id  TEXT NOT NULL REFERENCES compliance_evaluations(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  code  TEXT NOT NULL CHECK ((length(code) > 0 AND length(code) <= 60)),
  rule_id  TEXT CHECK (rule_id IS NULL OR (length(rule_id) > 0 AND length(rule_id) <= 40)),
  rule_status  TEXT CHECK (rule_status IS NULL OR rule_status IN ('ACTIVE','SUSPENDED','PARTIALLY_SUSPENDED','JURISDICTION_OVERRIDE','PENDING_IMPLEMENTATION','UNDER_LEGAL_REVIEW','UNKNOWN')),
  regulator  TEXT CHECK (regulator IS NULL OR (length(regulator) > 0 AND length(regulator) <= 20)),
  jurisdiction  TEXT CHECK (jurisdiction IS NULL OR jurisdiction GLOB '[A-Z][A-Z][A-Z]'),
  policy_version_id  TEXT CHECK (policy_version_id IS NULL OR (length(policy_version_id) > 0 AND length(policy_version_id) <= 80)),
  facet  TEXT CHECK (facet IS NULL OR (length(facet) > 0 AND length(facet) <= 80)),
  member_association  TEXT CHECK (member_association IS NULL OR (length(member_association) > 0 AND length(member_association) <= 80)),
  state  TEXT CHECK (state IS NULL OR (length(state) > 0 AND length(state) <= 80)),
  agent_user_id  TEXT CHECK (agent_user_id IS NULL OR (length(agent_user_id) > 0 AND length(agent_user_id) <= 80)),
  party_role  TEXT CHECK (party_role IS NULL OR (length(party_role) > 0 AND length(party_role) <= 80)),
  consent_kind  TEXT CHECK (consent_kind IS NULL OR (length(consent_kind) > 0 AND length(consent_kind) <= 80)),
  detail_text  TEXT CHECK (detail_text IS NULL OR (length(detail_text) > 0 AND length(detail_text) <= 300)),
  reason_text  TEXT CHECK (reason_text IS NULL OR (length(reason_text) > 0 AND length(reason_text) <= 80)),
  override_rule_id  TEXT CHECK (override_rule_id IS NULL OR (length(override_rule_id) > 0 AND length(override_rule_id) <= 80)),
  kind_text  TEXT CHECK (kind_text IS NULL OR (length(kind_text) > 0 AND length(kind_text) <= 80)),
  via_connected_agent  INTEGER CHECK (via_connected_agent IS NULL OR via_connected_agent = 1),
  has_party_roles  INTEGER NOT NULL DEFAULT 0 CHECK (has_party_roles IN (0,1)),
  has_jurisdictions  INTEGER NOT NULL DEFAULT 0 CHECK (has_jurisdictions IN (0,1)),
  PRIMARY KEY (evaluation_id, ord)
) STRICT;
CREATE TABLE compliance_evaluation_reason_items (
  evaluation_id  TEXT NOT NULL,
  reason_ord  INTEGER NOT NULL,
  list  TEXT NOT NULL CHECK (list IN ('partyRoles','jurisdictions')),
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  value  TEXT NOT NULL CHECK (length(value) > 0 AND length(value) <= 80),
  PRIMARY KEY (evaluation_id, reason_ord, list, ord),
  FOREIGN KEY (evaluation_id, reason_ord) REFERENCES compliance_evaluation_reasons(evaluation_id, ord) ON DELETE CASCADE
) STRICT;
CREATE TABLE compliance_evaluation_consents_outstanding (
  evaluation_id  TEXT NOT NULL REFERENCES compliance_evaluations(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  party_role  TEXT NOT NULL CHECK (party_role IN ('individual','engaging_entity','releasing_entity')),
  agent_user_id  TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  consent_kind  TEXT NOT NULL CHECK (consent_kind IN ('dual_representation','agency_performance','guardian_approach','guardian_agreement','legal_advice_ack')),
  reason_code  TEXT NOT NULL CHECK ((length(reason_code) > 0 AND length(reason_code) <= 60)),
  PRIMARY KEY (evaluation_id, ord),
  UNIQUE (evaluation_id, party_role, consent_kind)
) STRICT;
CREATE TABLE compliance_evaluation_policy_versions (
  evaluation_id  TEXT NOT NULL REFERENCES compliance_evaluations(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  policy_version_id  TEXT NOT NULL REFERENCES jurisdiction_policies(id) ON DELETE RESTRICT,
  PRIMARY KEY (evaluation_id, ord),
  UNIQUE (evaluation_id, policy_version_id)
) STRICT;
CREATE TABLE compliance_evaluation_snapshot_parties (
  evaluation_id  TEXT NOT NULL REFERENCES compliance_evaluations(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  party_role  TEXT NOT NULL CHECK (party_role IN ('individual','engaging_entity','releasing_entity')),
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('player','club')),
  subject_id  TEXT NOT NULL CHECK ((length(subject_id) > 0 AND length(subject_id) <= 80)),
  PRIMARY KEY (evaluation_id, ord)
) STRICT;
CREATE TABLE compliance_evaluation_snapshot_representations (
  evaluation_id  TEXT NOT NULL REFERENCES compliance_evaluations(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  agent_user_id  TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  party_role  TEXT NOT NULL CHECK (party_role IN ('individual','engaging_entity','releasing_entity')),
  status  TEXT NOT NULL CHECK (status IN ('verified','pending_review','withdrawn')),
  PRIMARY KEY (evaluation_id, ord)
) STRICT;
CREATE TABLE regulatory_reviews (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  kind  TEXT NOT NULL CHECK (kind IN ('verification_facet','representation_declared','conflict_evaluation','representation_dispute')),
  status  TEXT NOT NULL CHECK (status IN ('PENDING','IN_REVIEW','APPROVED','REJECTED','CANCELLED','SUPERSEDED')),
  agency_org_id  TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  agent_user_id  TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  subject_profile_id  TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  subject_user_id  TEXT CHECK (subject_user_id IS NULL OR (length(subject_user_id) > 0 AND length(subject_user_id) <= 80)),
  subject_facet  TEXT CHECK (subject_facet IS NULL OR subject_facet IN ('fifa_licence','national_registration','domestic_authorisation','minors_authorisation')),
  subject_member_association  TEXT CHECK (subject_member_association IS NULL OR subject_member_association GLOB '[A-Z][A-Z][A-Z]'),
  subject_agreement_id  TEXT REFERENCES representation_agreements(id) ON DELETE RESTRICT,
  subject_context_id  TEXT REFERENCES compliance_contexts(id) ON DELETE RESTRICT,
  subject_transaction_id  TEXT CHECK (subject_transaction_id IS NULL OR (length(subject_transaction_id) > 0 AND length(subject_transaction_id) <= 80)),
  subject_representation_id  TEXT CHECK (subject_representation_id IS NULL OR (length(subject_representation_id) > 0 AND length(subject_representation_id) <= 80)),
  subject_party_role  TEXT CHECK (subject_party_role IS NULL OR subject_party_role IN ('individual','engaging_entity','releasing_entity')),
  subject_is_approach  INTEGER NOT NULL CHECK (subject_is_approach IN (0,1)),
  subject_player_id  TEXT CHECK (subject_player_id IS NULL OR (length(subject_player_id) > 0 AND length(subject_player_id) <= 80)),
  subject_jurisdiction  TEXT CHECK (subject_jurisdiction IS NULL OR subject_jurisdiction GLOB '[A-Z][A-Z][A-Z]'),
  snapshot_outcome  TEXT CHECK (snapshot_outcome IS NULL OR snapshot_outcome IN ('CLEAR','PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED','PROHIBITED_CONFLICT','MANUAL_REGULATORY_REVIEW_REQUIRED','INSUFFICIENT_DATA')),
  snapshot_evaluation_id  TEXT REFERENCES compliance_evaluations(id) ON DELETE RESTRICT,
  snapshot_evaluated_at  INTEGER,
  requested_at  INTEGER NOT NULL,
  requested_by_kind  TEXT NOT NULL CHECK (requested_by_kind IN ('org','player','club_user','ts_reviewer','system')),
  requested_by_id  TEXT CHECK (requested_by_id IS NULL OR (length(requested_by_id) > 0 AND length(requested_by_id) <= 80)),
  requested_by_name  TEXT CHECK (requested_by_name IS NULL OR length(requested_by_name) <= 200),
  requested_by_role  TEXT CHECK (requested_by_role IS NULL OR length(requested_by_role) <= 60),
  started_at  INTEGER,
  started_by_id  TEXT REFERENCES ts_reviewers(id) ON DELETE RESTRICT,
  started_by_name  TEXT CHECK (started_by_name IS NULL OR length(started_by_name) <= 200),
  started_by_role  TEXT CHECK (started_by_role IS NULL OR started_by_role IN ('trust_safety_reviewer','trust_safety_admin')),
  decided_at  INTEGER,
  decision_reviewer_id  TEXT REFERENCES ts_reviewers(id) ON DELETE RESTRICT,
  decision_reviewer_name  TEXT CHECK (decision_reviewer_name IS NULL OR length(decision_reviewer_name) <= 200),
  decision_reviewer_role  TEXT CHECK (decision_reviewer_role IS NULL OR decision_reviewer_role IN ('trust_safety_reviewer','trust_safety_admin')),
  decision_outcome  TEXT CHECK (decision_outcome IS NULL OR decision_outcome IN ('APPROVED','REJECTED','CANCELLED')),
  decision_reason_code  TEXT CHECK (decision_reason_code IS NULL OR (length(decision_reason_code) > 0 AND length(decision_reason_code) <= 60)),
  decision_reason  TEXT CHECK (decision_reason IS NULL OR (length(decision_reason) > 0 AND length(decision_reason) <= 1000)),
  decision_at  INTEGER,
  prior_status  TEXT CHECK (prior_status IS NULL OR prior_status IN ('PENDING','IN_REVIEW','APPROVED','REJECTED','CANCELLED','SUPERSEDED')),
  prior_facet_state  TEXT CHECK (prior_facet_state IS NULL OR prior_facet_state IN ('UNVERIFIED','PENDING','VERIFIED','STALE','INACTIVE','MANUAL_REVIEW_REQUIRED')),
  prior_agreement_status  TEXT CHECK (prior_agreement_status IS NULL OR prior_agreement_status IN ('proposed','active','declined','expired','terminated_by_client','terminated_by_agent','disputed')),
  prior_context_outcome  TEXT CHECK (prior_context_outcome IS NULL OR prior_context_outcome IN ('CLEAR','PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED','PROHIBITED_CONFLICT','MANUAL_REGULATORY_REVIEW_REQUIRED','INSUFFICIENT_DATA')),
  prior_representation_status  TEXT CHECK (prior_representation_status IS NULL OR prior_representation_status IN ('verified','pending_review','withdrawn')),
  result_facet_state  TEXT CHECK (result_facet_state IS NULL OR result_facet_state IN ('UNVERIFIED','PENDING','VERIFIED','STALE','INACTIVE','MANUAL_REVIEW_REQUIRED')),
  result_agreement_status  TEXT CHECK (result_agreement_status IS NULL OR result_agreement_status IN ('proposed','active','declined','expired','terminated_by_client','terminated_by_agent','disputed')),
  result_context_outcome  TEXT CHECK (result_context_outcome IS NULL OR result_context_outcome IN ('CLEAR','PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED','PROHIBITED_CONFLICT','MANUAL_REGULATORY_REVIEW_REQUIRED','INSUFFICIENT_DATA')),
  result_representation_status  TEXT CHECK (result_representation_status IS NULL OR result_representation_status IN ('verified','pending_review','withdrawn')),
  result_note  TEXT CHECK (result_note IS NULL OR result_note IN ('profile gone','not disputed any more','context gone')),
  supersedes_id  TEXT REFERENCES regulatory_reviews(id) ON DELETE RESTRICT,
  superseded_by_id  TEXT REFERENCES regulatory_reviews(id) ON DELETE RESTRICT,
  resolve_key  TEXT CHECK (resolve_key IS NULL OR (length(resolve_key) > 0 AND length(resolve_key) <= 64)),
  resolve_fp  TEXT CHECK ((resolve_fp IS NULL OR length(resolve_fp) <= 4000) AND ((resolve_key IS NULL) = (resolve_fp IS NULL))),
  rev  INTEGER NOT NULL CHECK (rev >= 1),
  rev_at  INTEGER,
  rev_by_id  TEXT CHECK (rev_by_id IS NULL OR (length(rev_by_id) > 0 AND length(rev_by_id) <= 80)),
  rev_by_name  TEXT CHECK (rev_by_name IS NULL OR length(rev_by_name) <= 200),
  CHECK ((decision_outcome IS NULL) = (decision_reviewer_id IS NULL)),
  CHECK (snapshot_evaluation_id IS NULL OR snapshot_outcome IS NOT NULL)
) STRICT;
CREATE INDEX regulatory_reviews_queue ON regulatory_reviews(status, requested_at);
CREATE INDEX regulatory_reviews_agency ON regulatory_reviews(agency_org_id, agent_user_id);
CREATE INDEX regulatory_reviews_subject_facet ON regulatory_reviews(subject_profile_id, subject_facet, subject_member_association) WHERE subject_profile_id IS NOT NULL;
CREATE INDEX regulatory_reviews_subject_agreement ON regulatory_reviews(subject_agreement_id) WHERE subject_agreement_id IS NOT NULL;
CREATE INDEX regulatory_reviews_subject_context ON regulatory_reviews(subject_context_id) WHERE subject_context_id IS NOT NULL;
CREATE TABLE regulatory_review_reasons (
  review_id  TEXT NOT NULL REFERENCES regulatory_reviews(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  code  TEXT NOT NULL CHECK ((length(code) > 0 AND length(code) <= 60)),
  rule_id  TEXT CHECK (rule_id IS NULL OR (length(rule_id) > 0 AND length(rule_id) <= 40)),
  rule_status  TEXT CHECK (rule_status IS NULL OR rule_status IN ('ACTIVE','SUSPENDED','PARTIALLY_SUSPENDED','JURISDICTION_OVERRIDE','PENDING_IMPLEMENTATION','UNDER_LEGAL_REVIEW','UNKNOWN')),
  regulator  TEXT CHECK (regulator IS NULL OR (length(regulator) > 0 AND length(regulator) <= 20)),
  jurisdiction  TEXT CHECK (jurisdiction IS NULL OR jurisdiction GLOB '[A-Z][A-Z][A-Z]'),
  policy_version_id  TEXT CHECK (policy_version_id IS NULL OR (length(policy_version_id) > 0 AND length(policy_version_id) <= 80)),
  facet  TEXT CHECK (facet IS NULL OR (length(facet) > 0 AND length(facet) <= 80)),
  member_association  TEXT CHECK (member_association IS NULL OR (length(member_association) > 0 AND length(member_association) <= 80)),
  state  TEXT CHECK (state IS NULL OR (length(state) > 0 AND length(state) <= 80)),
  agent_user_id  TEXT CHECK (agent_user_id IS NULL OR (length(agent_user_id) > 0 AND length(agent_user_id) <= 80)),
  party_role  TEXT CHECK (party_role IS NULL OR (length(party_role) > 0 AND length(party_role) <= 80)),
  consent_kind  TEXT CHECK (consent_kind IS NULL OR (length(consent_kind) > 0 AND length(consent_kind) <= 80)),
  detail_text  TEXT CHECK (detail_text IS NULL OR (length(detail_text) > 0 AND length(detail_text) <= 300)),
  reason_text  TEXT CHECK (reason_text IS NULL OR (length(reason_text) > 0 AND length(reason_text) <= 80)),
  override_rule_id  TEXT CHECK (override_rule_id IS NULL OR (length(override_rule_id) > 0 AND length(override_rule_id) <= 80)),
  kind_text  TEXT CHECK (kind_text IS NULL OR (length(kind_text) > 0 AND length(kind_text) <= 80)),
  via_connected_agent  INTEGER CHECK (via_connected_agent IS NULL OR via_connected_agent = 1),
  has_party_roles  INTEGER NOT NULL DEFAULT 0 CHECK (has_party_roles IN (0,1)),
  has_jurisdictions  INTEGER NOT NULL DEFAULT 0 CHECK (has_jurisdictions IN (0,1)),
  PRIMARY KEY (review_id, ord)
) STRICT;
CREATE TABLE regulatory_review_reason_items (
  review_id  TEXT NOT NULL,
  reason_ord  INTEGER NOT NULL,
  list  TEXT NOT NULL CHECK (list IN ('partyRoles','jurisdictions')),
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  value  TEXT NOT NULL CHECK (length(value) > 0 AND length(value) <= 80),
  PRIMARY KEY (review_id, reason_ord, list, ord),
  FOREIGN KEY (review_id, reason_ord) REFERENCES regulatory_review_reasons(review_id, ord) ON DELETE CASCADE
) STRICT;
CREATE TABLE regulatory_review_policy_versions (
  review_id  TEXT NOT NULL REFERENCES regulatory_reviews(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  policy_version_id  TEXT NOT NULL REFERENCES jurisdiction_policies(id) ON DELETE RESTRICT,
  PRIMARY KEY (review_id, ord),
  UNIQUE (review_id, policy_version_id)
) STRICT;
CREATE TABLE regulatory_review_evidence_refs (
  review_id  TEXT NOT NULL REFERENCES regulatory_reviews(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0 AND ord < 10),
  ref  TEXT NOT NULL CHECK ((length(ref) > 0 AND length(ref) <= 200)),
  PRIMARY KEY (review_id, ord)
) STRICT;
CREATE TABLE regulatory_review_history (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  review_id  TEXT NOT NULL REFERENCES regulatory_reviews(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  at  INTEGER NOT NULL,
  by_kind  TEXT NOT NULL CHECK (by_kind IN ('org','player','club_user','ts_reviewer','system')),
  by_id  TEXT CHECK (by_id IS NULL OR (length(by_id) > 0 AND length(by_id) <= 80)),
  by_name  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  by_role  TEXT CHECK (by_role IS NULL OR length(by_role) <= 60),
  by_org_id  TEXT CHECK (by_org_id IS NULL OR (length(by_org_id) > 0 AND length(by_org_id) <= 80)),
  action  TEXT NOT NULL CHECK (action IN ('regulatory_review_requested','regulatory_review_started','regulatory_review_resolved','regulatory_review_cancelled','regulatory_review_superseded')),
  detail_rev  INTEGER,
  detail_review_id  TEXT REFERENCES regulatory_reviews(id) ON DELETE RESTRICT,
  detail_prior_status  TEXT CHECK (detail_prior_status IS NULL OR detail_prior_status IN ('PENDING','IN_REVIEW','APPROVED','REJECTED','CANCELLED','SUPERSEDED')),
  UNIQUE (review_id, ord)
) STRICT;
CREATE INDEX regulatory_review_history_decisions ON regulatory_review_history(at) WHERE action <> 'regulatory_review_requested';
CREATE TABLE compliance_context_history (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  context_id  TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  at  INTEGER NOT NULL,
  by_kind  TEXT NOT NULL CHECK (by_kind IN ('org','player','club_user','ts_reviewer','system')),
  by_id  TEXT CHECK (by_id IS NULL OR (length(by_id) > 0 AND length(by_id) <= 80)),
  by_name  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  by_role  TEXT CHECK (by_role IS NULL OR length(by_role) <= 60),
  by_org_id  TEXT CHECK (by_org_id IS NULL OR (length(by_org_id) > 0 AND length(by_org_id) <= 80)),
  action  TEXT NOT NULL CHECK (action IN ('compliance_context_opened','compliance_context_party_added','compliance_context_party_removed','compliance_representation_declared','compliance_representation_verified','compliance_representation_withdrawn','compliance_context_evaluated','compliance_context_policy_changed','compliance_context_closed')),
  detail_party_role  TEXT CHECK (detail_party_role IS NULL OR detail_party_role IN ('individual','engaging_entity','releasing_entity')),
  detail_subject_kind  TEXT CHECK (detail_subject_kind IS NULL OR detail_subject_kind IN ('player','club')),
  detail_status  TEXT CHECK (detail_status IS NULL OR detail_status IN ('verified','pending_review','withdrawn')),
  detail_review_outcome  TEXT CHECK (detail_review_outcome IS NULL OR detail_review_outcome IN ('review_approved','review_rejected')),
  detail_evaluation_id  TEXT REFERENCES compliance_evaluations(id) ON DELETE RESTRICT,
  detail_review_id  TEXT REFERENCES regulatory_reviews(id) ON DELETE RESTRICT,
  detail_policy_version_id  TEXT REFERENCES jurisdiction_policies(id) ON DELETE RESTRICT,
  UNIQUE (context_id, ord)
) STRICT;
CREATE TABLE compliance_context_history_policy_versions (
  history_id  TEXT NOT NULL REFERENCES compliance_context_history(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  policy_version_id  TEXT NOT NULL REFERENCES jurisdiction_policies(id) ON DELETE RESTRICT,
  PRIMARY KEY (history_id, ord),
  UNIQUE (history_id, policy_version_id)
) STRICT;
CREATE TABLE regulatory_consents (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  kind  TEXT NOT NULL CHECK (kind IN ('dual_representation','agency_performance','guardian_approach','guardian_agreement','legal_advice_ack')),
  context_id  TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE RESTRICT,
  agent_user_id  TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  agency_org_id  TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  party_role  TEXT NOT NULL CHECK (party_role IN ('individual','engaging_entity','releasing_entity')),
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('player','club')),
  subject_id  TEXT NOT NULL CHECK ((length(subject_id) > 0 AND length(subject_id) <= 80)),
  status  TEXT NOT NULL CHECK (status IN ('requested','granted','declined')),
  requested_at  INTEGER NOT NULL,
  requested_by_kind  TEXT NOT NULL CHECK (requested_by_kind IN ('org','player','club_user','ts_reviewer','system')),
  requested_by_id  TEXT CHECK (requested_by_id IS NULL OR (length(requested_by_id) > 0 AND length(requested_by_id) <= 80)),
  requested_by_name  TEXT CHECK (requested_by_name IS NULL OR length(requested_by_name) <= 200),
  requested_by_role  TEXT CHECK (requested_by_role IS NULL OR length(requested_by_role) <= 60),
  granted_at  INTEGER,
  granted_by_kind  TEXT CHECK (granted_by_kind IS NULL OR granted_by_kind IN ('player','club_user')),
  granted_by_id  TEXT CHECK (granted_by_id IS NULL OR (length(granted_by_id) > 0 AND length(granted_by_id) <= 80)),
  granted_by_name  TEXT CHECK (granted_by_name IS NULL OR length(granted_by_name) <= 200),
  granted_by_org_id  TEXT CHECK (granted_by_org_id IS NULL OR (length(granted_by_org_id) > 0 AND length(granted_by_org_id) <= 80)),
  granted_by_signatory  INTEGER CHECK (granted_by_signatory IS NULL OR granted_by_signatory = 1),
  declined_at  INTEGER,
  declined_by_kind  TEXT CHECK (declined_by_kind IS NULL OR declined_by_kind IN ('player','club_user')),
  declined_by_id  TEXT CHECK (declined_by_id IS NULL OR (length(declined_by_id) > 0 AND length(declined_by_id) <= 80)),
  declined_by_name  TEXT CHECK (declined_by_name IS NULL OR length(declined_by_name) <= 200),
  declined_by_org_id  TEXT CHECK (declined_by_org_id IS NULL OR (length(declined_by_org_id) > 0 AND length(declined_by_org_id) <= 80)),
  full_particulars_provided  INTEGER NOT NULL CHECK (full_particulars_provided IN (0,1)),
  legal_advice_offered  INTEGER NOT NULL CHECK (legal_advice_offered IN (0,1)),
  proposed_fee_disclosed  INTEGER NOT NULL CHECK (proposed_fee_disclosed IN (0,1)),
  acknowledged_at  INTEGER,
  request_key  TEXT CHECK (request_key IS NULL OR (length(request_key) > 0 AND length(request_key) <= 64)),
  request_fp  TEXT CHECK ((request_fp IS NULL OR length(request_fp) <= 4000) AND ((request_key IS NULL) = (request_fp IS NULL))),
  grant_key  TEXT CHECK (grant_key IS NULL OR (length(grant_key) > 0 AND length(grant_key) <= 64)),
  grant_fp  TEXT CHECK ((grant_fp IS NULL OR length(grant_fp) <= 4000) AND ((grant_key IS NULL) = (grant_fp IS NULL))),
  decline_key  TEXT CHECK (decline_key IS NULL OR (length(decline_key) > 0 AND length(decline_key) <= 64)),
  decline_fp  TEXT CHECK ((decline_fp IS NULL OR length(decline_fp) <= 4000) AND ((decline_key IS NULL) = (decline_fp IS NULL))),
  revoke_key  TEXT CHECK (revoke_key IS NULL OR (length(revoke_key) > 0 AND length(revoke_key) <= 64)),
  revoke_fp  TEXT CHECK ((revoke_fp IS NULL OR length(revoke_fp) <= 4000) AND ((revoke_key IS NULL) = (revoke_fp IS NULL))),
  rev  INTEGER NOT NULL CHECK (rev >= 1),
  rev_at  INTEGER,
  rev_by_id  TEXT CHECK (rev_by_id IS NULL OR (length(rev_by_id) > 0 AND length(rev_by_id) <= 80)),
  rev_by_name  TEXT CHECK (rev_by_name IS NULL OR length(rev_by_name) <= 200),
  CHECK ((status = 'granted') = (granted_at IS NOT NULL AND granted_by_kind IS NOT NULL)),
  CHECK ((status = 'declined') = (declined_at IS NOT NULL AND declined_by_kind IS NOT NULL)),
  CHECK ((status = 'granted') = (acknowledged_at IS NOT NULL))
) STRICT;
CREATE INDEX regulatory_consents_context ON regulatory_consents(context_id, agent_user_id);
CREATE INDEX regulatory_consents_subject ON regulatory_consents(subject_kind, subject_id);
CREATE INDEX regulatory_consents_agency ON regulatory_consents(agency_org_id, agent_user_id);
CREATE UNIQUE INDEX regulatory_consents_request_key ON regulatory_consents(context_id, agent_user_id, request_key) WHERE request_key IS NOT NULL;
CREATE TABLE regulatory_consent_regarding (
  consent_id  TEXT NOT NULL REFERENCES regulatory_consents(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  party_role  TEXT NOT NULL CHECK (party_role IN ('individual','engaging_entity','releasing_entity')),
  PRIMARY KEY (consent_id, ord),
  UNIQUE (consent_id, party_role)
) STRICT;
CREATE TABLE regulatory_consent_policy_versions (
  consent_id  TEXT NOT NULL REFERENCES regulatory_consents(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  policy_version_id  TEXT NOT NULL REFERENCES jurisdiction_policies(id) ON DELETE RESTRICT,
  PRIMARY KEY (consent_id, ord),
  UNIQUE (consent_id, policy_version_id)
) STRICT;
CREATE TABLE regulatory_consent_rule_ids (
  consent_id  TEXT NOT NULL REFERENCES regulatory_consents(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  rule_id  TEXT NOT NULL CHECK (length(rule_id) > 0 AND length(rule_id) <= 40),
  PRIMARY KEY (consent_id, ord),
  UNIQUE (consent_id, rule_id)
) STRICT;
CREATE TABLE regulatory_consent_revocations (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  consent_id  TEXT NOT NULL UNIQUE REFERENCES regulatory_consents(id) ON DELETE CASCADE,
  revoked_at  INTEGER NOT NULL,
  by_kind  TEXT NOT NULL CHECK (by_kind IN ('player','club_user')),
  by_id  TEXT CHECK (by_id IS NULL OR (length(by_id) > 0 AND length(by_id) <= 80)),
  by_name  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  by_org_id  TEXT CHECK (by_org_id IS NULL OR (length(by_org_id) > 0 AND length(by_org_id) <= 80))
) STRICT;
CREATE TABLE regulatory_consent_history (
  id  TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  consent_id  TEXT NOT NULL REFERENCES regulatory_consents(id) ON DELETE CASCADE,
  ord  INTEGER NOT NULL CHECK (ord >= 0),
  at  INTEGER NOT NULL,
  by_kind  TEXT NOT NULL CHECK (by_kind IN ('org','player','club_user','ts_reviewer','system')),
  by_id  TEXT CHECK (by_id IS NULL OR (length(by_id) > 0 AND length(by_id) <= 80)),
  by_name  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  by_role  TEXT CHECK (by_role IS NULL OR length(by_role) <= 60),
  by_org_id  TEXT CHECK (by_org_id IS NULL OR (length(by_org_id) > 0 AND length(by_org_id) <= 80)),
  action  TEXT NOT NULL CHECK (action IN ('regulatory_consent_requested','regulatory_consent_granted','regulatory_consent_declined','regulatory_consent_revoked')),
  UNIQUE (consent_id, ord)
) STRICT;


-- -----------------------------------------------------------------------------
-- source: db.agentTransactions   created at domains/agents/transactions/index.mjs:594
--         (POST /org/agent/transactions); migration 2307 creates the empty store
-- owner/writer: m26 (agent lane: parties, representations, status, terms,
--         links, documents, notes; club lane: confirm, documents, notes,
--         message link, trial link; player lane: confirm, documents;
--         compliance re-evaluation writes the snapshot and compliance-driven
--         status moves); m26 onPlayerDeleted (tombstone); m27 bindHandoff
--         records the transaction id on recruitment_cases.transactionHandoff.
-- lifecycle: status DRAFT | PARTIES_CONFIRMED | COMPLIANCE_PENDING |
--         COMPLIANCE_BLOCKED | READY | ACTIVE | ON_HOLD | CANCELLED | CLOSED |
--         ARCHIVED per ACTOR_TRANSITIONS / COMPLIANCE_TRANSITIONS
--         (domains/agents/transactions/transaction.mjs:122/145). Never deleted; ARCHIVED is read-only.
-- mapping: id -> id (atx-*); agencyOrgId -> agency_org_id; agentUserId ->
--   agent_user_id; type -> type; jurisdictions[] -> agent_transaction_jurisdictions;
--   status -> status; parties[] -> transaction_parties; contextId -> context_id
--   (1:1 with compliance_contexts, set at creation); compliance{} (snapshot,
--   domains/agents/transactions/index.mjs:204) -> compliance_evaluation_id (either a compliance_evaluations
--     id '<ctx>#<n>' or '<tx-id>#gate' when the facet gate refused before the
--     engine ran — hence no FK), compliance_context_id, compliance_evaluated_at,
--     policyVersions[] -> agent_transaction_compliance_policy_versions,
--     outcome -> compliance_outcome, reasonCodes[] ->
--     agent_transaction_compliance_reason_codes, pendingReason ->
--     compliance_pending_reason, blocked -> compliance_blocked, clear ->
--     compliance_clear, consentRequirements[] -> agent_transaction_consent_requirements,
--     verificationFreshness -> compliance_verification_freshness (the agent's
--     fifa_licence effective state at evaluation), partyRevision ->
--     compliance_party_revision (sha256 hex), state{} -> derived, not stored
--     (state.outcome/reasonCodes/pendingReason/blocked/clear duplicate the
--     columns; state.consentsOutstanding duplicates consent_requirements
--     including agent_user_id); compliance null -> compliance_evaluation_id NULL;
--   reEvaluationPending -> re_evaluation_pending; notes[] -> transaction_notes;
--   linkedThreads[] -> transaction_linked_threads; links{trialId,opportunityId,
--     recruitmentCaseId} -> link_trial_id / link_opportunity_id /
--     link_recruitment_case_id; terms.versions[] -> transaction_terms_versions;
--   holdReasonCode/holdReason/heldAt -> hold_reason_code / hold_reason (≤400) /
--     held_at (all cleared on ACTIVE); cancelReasonCode/cancelledAt ->
--     cancel_reason_code / cancelled_at; closeReasonCode/closedAt ->
--     close_reason_code / closed_at; archivedAt -> archived_at;
--   initiatedBy{kind,userId,name} -> initiated_by_kind / initiated_by_user_id /
--     initiated_by_name; initiatedAt -> initiated_at; createdAt/updatedAt ->
--     created_at / updated_at; keys.create -> idempotency_keys (action
--     'create'); keys['party:<key>'] -> idempotency_keys (action 'party', key =
--     <key>); keys['status:<key>'] -> idempotency_keys (action 'status');
--   rev/revAt/revBy -> rev / rev_at / rev_by_label (bumpTxRev stores
--     {userId:null, name:<role label>} — the ROLE, never a person, by design
--     domains/agents/transactions/index.mjs:104; rev_by_user_id is therefore omitted: always null);
--   history[] -> transaction_history.
-- notes: duplicate rule "one live transaction per (individual, type, engaging
--   org, releasing org)" is enforced by code over parties[] (m27
--   duplicateTransactionOf) — no index. Derived projection ids (playerId,
--   engagingOrgId, releasingOrgId) are computed from transaction_parties.
--   Tenant privacy: a colleague's transaction is concealed (404).
-- -----------------------------------------------------------------------------
CREATE TABLE agent_transactions (
  id                                 TEXT PRIMARY KEY,
  agency_org_id                      TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  agent_user_id                      TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  type                               TEXT NOT NULL CHECK (type IN ('employment_contract','transfer','loan','other_services')),
  status                             TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PARTIES_CONFIRMED','COMPLIANCE_PENDING','COMPLIANCE_BLOCKED','READY','ACTIVE','ON_HOLD','CANCELLED','CLOSED','ARCHIVED')),
  context_id                         TEXT REFERENCES compliance_contexts(id) ON DELETE RESTRICT,
  -- compliance snapshot (null when compliance_evaluation_id is null) --
  compliance_evaluation_id           TEXT,              -- compliance_evaluations(id) or '<tx-id>#gate'; no FK
  compliance_context_id              TEXT REFERENCES compliance_contexts(id) ON DELETE RESTRICT,
  compliance_evaluated_at            INTEGER,
  compliance_outcome                 TEXT CHECK (compliance_outcome IS NULL OR compliance_outcome IN ('CLEAR','PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED','PROHIBITED_CONFLICT','MANUAL_REGULATORY_REVIEW_REQUIRED','INSUFFICIENT_DATA')),
  compliance_pending_reason          TEXT CHECK (compliance_pending_reason IS NULL OR compliance_pending_reason IN ('CONSENT_REQUIRED','MANUAL_REVIEW','INSUFFICIENT_DATA','PROVIDER_UNAVAILABLE','JURISDICTION_UNSUPPORTED','FACET_NOT_VERIFIED','PARTIES_NOT_CONFIRMED','REPRESENTATION_MISSING')),
  compliance_blocked                 INTEGER NOT NULL DEFAULT 0 CHECK (compliance_blocked IN (0,1)),
  compliance_clear                   INTEGER NOT NULL DEFAULT 0 CHECK (compliance_clear IN (0,1)),
  compliance_verification_freshness  TEXT CHECK (compliance_verification_freshness IS NULL OR compliance_verification_freshness IN ('UNVERIFIED','PENDING','VERIFIED','STALE','INACTIVE','MANUAL_REVIEW_REQUIRED')),
  compliance_party_revision          TEXT CHECK (compliance_party_revision IS NULL OR length(compliance_party_revision) = 64),
  re_evaluation_pending              INTEGER NOT NULL DEFAULT 0 CHECK (re_evaluation_pending IN (0,1)),
  -- links (references only; nothing is copied) --
  link_trial_id                      TEXT REFERENCES trials(id) ON DELETE SET NULL,
  link_opportunity_id                TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
  link_recruitment_case_id           TEXT REFERENCES recruitment_cases(id) ON DELETE SET NULL,   -- visible only to agent + owning engaging club
  -- hold / end --
  hold_reason_code                   TEXT CHECK (hold_reason_code IS NULL OR hold_reason_code IN ('awaiting_party_decision','awaiting_document','awaiting_regulatory_answer','window_closed','party_request','other')),
  hold_reason                        TEXT,
  held_at                            INTEGER,
  cancel_reason_code                 TEXT CHECK (cancel_reason_code IS NULL OR cancel_reason_code IN ('party_withdrew','terms_not_agreed','window_closed','compliance_not_cleared','duplicate','other')),
  cancelled_at                       INTEGER,
  close_reason_code                  TEXT CHECK (close_reason_code IS NULL OR close_reason_code IN ('process_concluded','proceeded_outside_scoutbox','superseded','other')),
  closed_at                          INTEGER,
  archived_at                        INTEGER,
  -- provenance --
  initiated_by_kind                  TEXT NOT NULL CHECK (initiated_by_kind IN ('org')),
  initiated_by_user_id               TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  initiated_by_name                  TEXT,              -- snapshot
  initiated_at                       INTEGER NOT NULL,
  created_at                         INTEGER NOT NULL,
  updated_at                         INTEGER NOT NULL,
  rev                                INTEGER NOT NULL DEFAULT 1,
  rev_at                             INTEGER,
  rev_by_label                       TEXT,              -- role label ('Representing agent', 'Club signatory', 'Player', …), never a person
  CHECK ((compliance_evaluation_id IS NULL) = (compliance_evaluated_at IS NULL))
) STRICT;
CREATE INDEX agent_transactions_agency_agent_status ON agent_transactions(agency_org_id, agent_user_id, status);
CREATE INDEX agent_transactions_status ON agent_transactions(status);
CREATE INDEX agent_transactions_case ON agent_transactions(link_recruitment_case_id);
CREATE UNIQUE INDEX agent_transactions_context ON agent_transactions(context_id) WHERE context_id IS NOT NULL;

-- source: db.agentTransactions[].jurisdictions[]  (upper-cased 3-letter codes, de-duplicated)
CREATE TABLE agent_transaction_jurisdictions (
  transaction_id      TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE CASCADE,
  member_association  TEXT NOT NULL CHECK (length(member_association) = 3),
  PRIMARY KEY (transaction_id, member_association)
) STRICT;

-- source: db.agentTransactions[].compliance.policyVersions[]  (snapshot copy of
--         the evaluation's policy set; [] for a gate snapshot)
CREATE TABLE agent_transaction_compliance_policy_versions (
  transaction_id     TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE CASCADE,
  policy_version_id  TEXT NOT NULL REFERENCES jurisdiction_policies(id) ON DELETE RESTRICT,
  PRIMARY KEY (transaction_id, policy_version_id)
) STRICT;

-- source: db.agentTransactions[].compliance.reasonCodes[]  (de-duplicated codes
--         from the evaluation's reasons or the gate's reasons)
CREATE TABLE agent_transaction_compliance_reason_codes (
  transaction_id  TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,
  PRIMARY KEY (transaction_id, code)
) STRICT;

-- source: db.agentTransactions[].compliance.consentRequirements[]
--         ({partyRole, consentKind, reasonCode}) merged with
--         compliance.state.consentsOutstanding[] ({…, agentUserId})
CREATE TABLE agent_transaction_consent_requirements (
  transaction_id  TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE CASCADE,
  party_role      TEXT NOT NULL CHECK (party_role IN ('individual','engaging_entity','releasing_entity')),
  consent_kind    TEXT NOT NULL CHECK (consent_kind IN ('dual_representation')),
  agent_user_id   TEXT,
  reason_code     TEXT NOT NULL,
  PRIMARY KEY (transaction_id, party_role, consent_kind)
) STRICT;

-- source: db.agentTransactions[].parties[]  created at domains/agents/transactions/index.mjs:494/499
--         (resolveParty: id txp-*)
-- owner/writer: m26 (add, remove; club/player confirm; onPlayerDeleted tombstone)
-- lifecycle: removed soft marker; cap 12 rows (TRANSACTION_LIMITS.parties*3);
--         one un-removed party per role.
-- mapping: id -> id; partyRole -> party_role; subjectKind/subjectId ->
--   subject_kind / subject_id (polymorphic: players(id) | orgs(id) club; no FK —
--   the row outlives a removed player as an id); addedAt -> added_at;
--   addedBy{kind,userId,name} -> added_by_kind / added_by_user_id / added_by_name;
--   removed -> removed; removedAt -> removed_at; confirmedAt -> confirmed_at;
--   confirmedBy{kind player|club_user,userId,name,orgId?} -> confirmed_by_kind /
--   confirmed_by_user_id / confirmed_by_name / confirmed_by_org_id (player
--   actors reduced to NULL ids/names on deletion); subjectRemovedAt ->
--   subject_removed_at; history[] -> transaction_party_history.
-- notes: the compliance context mirrors these rows (projection) under
--   compliance_context_parties with the same txp-* ids.
CREATE TABLE transaction_parties (
  id                    TEXT PRIMARY KEY,
  transaction_id        TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE CASCADE,
  party_role            TEXT NOT NULL CHECK (party_role IN ('individual','engaging_entity','releasing_entity')),
  subject_kind          TEXT NOT NULL CHECK (subject_kind IN ('player','club')),
  subject_id            TEXT NOT NULL,                  -- polymorphic with subject_kind; no FK
  added_at              INTEGER NOT NULL,
  added_by_kind         TEXT CHECK (added_by_kind IN ('org')),
  added_by_user_id      TEXT,
  added_by_name         TEXT,                          -- snapshot
  removed               INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0,1)),
  removed_at            INTEGER,
  confirmed_at          INTEGER,
  confirmed_by_kind     TEXT CHECK (confirmed_by_kind IS NULL OR confirmed_by_kind IN ('player','club_user')),
  confirmed_by_user_id  TEXT,
  confirmed_by_name     TEXT,                          -- snapshot; nulled on player deletion
  confirmed_by_org_id   TEXT,
  subject_removed_at    INTEGER,
  CHECK (subject_kind <> 'player' OR party_role = 'individual'),
  CHECK (subject_kind <> 'club' OR party_role <> 'individual')
) STRICT;
CREATE INDEX transaction_parties_transaction ON transaction_parties(transaction_id);
CREATE INDEX transaction_parties_subject ON transaction_parties(subject_kind, subject_id) WHERE removed = 0;   -- club lane / player lane listing
CREATE UNIQUE INDEX transaction_parties_live_role ON transaction_parties(transaction_id, party_role) WHERE removed = 0;   -- new; code enforces

-- source: db.agentTransactions[].parties[].history[]  (domains/agents/transactions/index.mjs:602/648/674/1177/1266)
-- actions: transaction_party_added, transaction_party_removed, transaction_party_confirmed
CREATE TABLE transaction_party_history (
  id           TEXT PRIMARY KEY,
  party_id     TEXT NOT NULL REFERENCES transaction_parties(id) ON DELETE RESTRICT,
  at           INTEGER NOT NULL,
  by_kind      TEXT CHECK (by_kind IN ('org','player','club_user','ts_reviewer','system')),
  by_id        TEXT,
  by_name      TEXT,
  by_role      TEXT,
  by_org_id    TEXT,
  action       TEXT NOT NULL,
  detail_json  TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX transaction_party_history_party ON transaction_party_history(party_id, at);

-- source: db.agentTransactions[].notes[]  created at domains/agents/transactions/index.mjs:1120 (addNote;
--         agent and club lanes; id txn-*); cap 200.
-- mapping: id -> id; visibility -> visibility (NOTE_VISIBILITY = document
--   classes minus T_AND_S_ONLY); text -> text (≤2000); by -> by_*; at ->
--   created_at (source field `at`); removedAt -> removed_at (initialised null
--   and NEVER SET by any code path; readers filter on it — kept nullable).
-- notes: a note is absent, not redacted, for anyone its class excludes.
CREATE TABLE transaction_notes (
  id              TEXT PRIMARY KEY,
  transaction_id  TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE CASCADE,
  visibility      TEXT NOT NULL CHECK (visibility IN ('AGENT_PRIVATE','PLAYER_PRIVATE','ENGAGING_CLUB_PRIVATE','RELEASING_CLUB_PRIVATE','PLAYER_AGENT_SHARED','ENGAGING_AGENT_SHARED','RELEASING_AGENT_SHARED','ALL_TRANSACTION_PARTIES')),
  text            TEXT NOT NULL,
  by_kind         TEXT CHECK (by_kind IN ('org','club_user','player')),
  by_id           TEXT,
  by_name         TEXT,                                 -- snapshot; nulled on player deletion
  by_org_id       TEXT,
  created_at      INTEGER NOT NULL,
  removed_at      INTEGER                               -- never written today
) STRICT;
CREATE INDEX transaction_notes_transaction ON transaction_notes(transaction_id, created_at);

-- source: db.agentTransactions[].linkedThreads[]  created at domains/agents/transactions/index.mjs:1222
--         (club signatory links a canonical Inbox channel; id txm-*); cap 20.
-- mapping: id -> id; channelId -> channel_id (-> channels(id), 03; SET NULL
--   because channels are deleted on player deletion while the link row is an
--   audit fact that a conversation existed); linkedBy{kind,userId,name,orgId}
--   -> linked_by_*; linkedAt -> linked_at.
-- notes: one link per (transaction, channel) enforced by code (idempotent
--   replay); readability is re-derived from the channel's own gate.
CREATE TABLE transaction_linked_threads (
  id                 TEXT PRIMARY KEY,
  transaction_id     TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE CASCADE,
  channel_id         TEXT REFERENCES channels(id) ON DELETE SET NULL,
  linked_by_kind     TEXT CHECK (linked_by_kind IN ('club_user')),
  linked_by_user_id  TEXT,
  linked_by_name     TEXT,                              -- snapshot
  linked_by_org_id   TEXT,
  linked_at          INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX transaction_linked_threads_channel ON transaction_linked_threads(transaction_id, channel_id) WHERE channel_id IS NOT NULL;   -- enforced by code today

-- source: db.agentTransactions[].terms.versions[]  created at domains/agents/transactions/index.mjs:957
--         (POST /org/agent/transactions/:id/terms; id txt-*); cap 50.
-- mapping: id -> id; version -> version (1-based, length+1 at write);
--   at -> recorded_at; by -> recorded_by_*; recordedFor -> recorded_for;
--   visibility -> visibility (uploadable classes of the agent; never T_AND_S_ONLY);
--   summary -> summary (≤2000, prose; ScoutBox validates no fee/cap/duration).
CREATE TABLE transaction_terms_versions (
  id                   TEXT PRIMARY KEY,
  transaction_id       TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE CASCADE,
  version              INTEGER NOT NULL CHECK (version >= 1),
  recorded_at          INTEGER NOT NULL,
  recorded_by_kind     TEXT CHECK (recorded_by_kind IN ('org')),
  recorded_by_user_id  TEXT,
  recorded_by_name     TEXT,                            -- snapshot
  recorded_for         TEXT NOT NULL CHECK (recorded_for IN ('individual','engaging_entity','releasing_entity')),
  visibility           TEXT NOT NULL CHECK (visibility IN ('AGENT_PRIVATE','PLAYER_PRIVATE','ENGAGING_CLUB_PRIVATE','RELEASING_CLUB_PRIVATE','PLAYER_AGENT_SHARED','ENGAGING_AGENT_SHARED','RELEASING_AGENT_SHARED','ALL_TRANSACTION_PARTIES')),
  summary              TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX transaction_terms_versions_version ON transaction_terms_versions(transaction_id, version);

-- source: db.agentTransactions[].history[]  (domains/agents/transactions/index.mjs hist on the tx; all lanes)
-- actions: transaction_created, transaction_party_added, transaction_party_removed,
--   transaction_party_confirmed, transaction_representation_attached,
--   transaction_representation_withdrawn, transaction_compliance_evaluated,
--   transaction_compliance_stale, transaction_status_changed, transaction_held,
--   transaction_cancelled, transaction_closed, transaction_archived,
--   transaction_document_added, transaction_document_superseded,
--   transaction_note_added, transaction_message_linked, transaction_terms_recorded,
--   transaction_subject_tombstoned
-- notes: the timeline audience (all_parties | agent_only | player_and_agent |
--   club_side | per_document | audit_only) is derived from action
--   (timelineAudienceOf) — not stored. Link routes record a no-op
--   transaction_status_changed {from:x,to:x} (domains/agents/transactions/index.mjs:978/1239).
--   Player actors anonymised on deletion.
CREATE TABLE transaction_history (
  id              TEXT PRIMARY KEY,
  transaction_id  TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE RESTRICT,
  at              INTEGER NOT NULL,
  by_kind         TEXT CHECK (by_kind IN ('org','player','club_user','ts_reviewer','system')),
  by_id           TEXT,
  by_name         TEXT,
  by_role         TEXT,
  by_org_id       TEXT,
  action          TEXT NOT NULL,
  detail_json     TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX transaction_history_transaction ON transaction_history(transaction_id, at);


-- -----------------------------------------------------------------------------
-- source: db.transactionRepresentations   created at domains/agents/transactions/index.mjs:784
--         (POST /org/agent/transactions/:id/representations)
-- owner/writer: m26 (attach, withdraw, party removal withdraws, review
--         decision via representationReviewed, onPlayerDeleted withdraws)
-- lifecycle: status verified | pending_review | withdrawn (terminal). Never deleted.
-- mapping: id -> id (txr-*); transactionId -> transaction_id; agencyOrgId ->
--   agency_org_id; agentUserId -> agent_user_id; partyRole -> party_role;
--   agreementId -> agreement_id (null for a declared-only entity binding);
--   declaredOnly -> declared_only; declaredEvidenceId -> declared_evidence_id
--     (initialised null, NEVER WRITTEN — -- dead field today; kept as a
--     nullable reference to ver_evidence(id), 05, no FK);
--   scope[] -> transaction_representation_scopes (copied from the agreement at
--     bind time — a snapshot, by design: the binding was made on that scope);
--   jurisdictions[] -> transaction_representation_jurisdictions ([agreement.jurisdiction]
--     or []); status -> status; reviewId -> review_id; createdAt -> created_at;
--   verifiedAt -> verified_at; verifiedByReviewId -> verified_by_review_id;
--   firstActAt -> first_act_at; withdrawnAt -> withdrawn_at; withdrawnReason ->
--   withdrawn_reason; keys.attach{key,fp} -> idempotency_keys (action 'attach',
--   fp over {partyRole, agreementId}); rev/revAt/revBy -> rev / rev_at /
--   rev_by_user_id / rev_by_name (bumped by both bumpRev(user) at :680 and
--   bumpTxRev(label) at :820/1401, so rev_by_name may be a person OR a role
--   label); history[] -> transaction_representation_history.
-- notes: one non-withdrawn row per (transaction, partyRole, agent) enforced by
--   code (TRANSACTION_PARTY_EXISTS); partial unique index is new. The
--   compliance context mirrors these rows as compliance_context_representations
--   with the same txr-* ids (projection; this table is the truth).
-- -----------------------------------------------------------------------------
CREATE TABLE transaction_representations (
  id                     TEXT PRIMARY KEY,
  transaction_id         TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE RESTRICT,
  agency_org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  agent_user_id          TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  party_role             TEXT NOT NULL CHECK (party_role IN ('individual','engaging_entity','releasing_entity')),
  agreement_id           TEXT REFERENCES representation_agreements(id) ON DELETE RESTRICT,
  declared_only          INTEGER NOT NULL DEFAULT 0 CHECK (declared_only IN (0,1)),
  declared_evidence_id   TEXT,                          -- -> ver_evidence(id); never written today
  status                 TEXT NOT NULL CHECK (status IN ('verified','pending_review','withdrawn')),
  review_id              TEXT REFERENCES regulatory_reviews(id) ON DELETE SET NULL,
  created_at             INTEGER NOT NULL,
  verified_at            INTEGER,
  verified_by_review_id  TEXT REFERENCES regulatory_reviews(id) ON DELETE SET NULL,
  first_act_at           INTEGER,
  withdrawn_at           INTEGER,
  withdrawn_reason       TEXT CHECK (withdrawn_reason IS NULL OR withdrawn_reason IN ('party_removed','agent_withdrew','subject_removed','review_rejected')),
  rev                    INTEGER NOT NULL DEFAULT 1,
  rev_at                 INTEGER,
  rev_by_user_id         TEXT,
  rev_by_name            TEXT,                          -- snapshot or role label
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL))
) STRICT;
CREATE INDEX transaction_representations_transaction ON transaction_representations(transaction_id);
CREATE INDEX transaction_representations_agency ON transaction_representations(agency_org_id);
CREATE UNIQUE INDEX transaction_representations_live ON transaction_representations(transaction_id, party_role, agent_user_id) WHERE status <> 'withdrawn';   -- new; code enforces

-- source: db.transactionRepresentations[].scope[]  (snapshot of agreement.scope at bind)
CREATE TABLE transaction_representation_scopes (
  representation_id  TEXT NOT NULL REFERENCES transaction_representations(id) ON DELETE CASCADE,
  scope              TEXT NOT NULL CHECK (scope IN ('employment','transfer','commercial','other_services')),
  PRIMARY KEY (representation_id, scope)
) STRICT;

-- source: db.transactionRepresentations[].jurisdictions[]  ([agreement.jurisdiction] or [])
CREATE TABLE transaction_representation_jurisdictions (
  representation_id   TEXT NOT NULL REFERENCES transaction_representations(id) ON DELETE CASCADE,
  member_association  TEXT NOT NULL CHECK (member_association IN ('INT','ENG','USA')),
  PRIMARY KEY (representation_id, member_association)
) STRICT;

-- source: db.transactionRepresentations[].history[]
-- actions: transaction_representation_attached, transaction_representation_withdrawn
CREATE TABLE transaction_representation_history (
  id                 TEXT PRIMARY KEY,
  representation_id  TEXT NOT NULL REFERENCES transaction_representations(id) ON DELETE RESTRICT,
  at                 INTEGER NOT NULL,
  by_kind            TEXT CHECK (by_kind IN ('org','player','club_user','ts_reviewer','system')),
  by_id              TEXT,
  by_name            TEXT,
  by_role            TEXT,
  by_org_id          TEXT,
  action             TEXT NOT NULL,
  detail_json        TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX transaction_representation_history_representation ON transaction_representation_history(representation_id, at);


-- -----------------------------------------------------------------------------
-- source: db.transactionDocuments   created at domains/agents/transactions/index.mjs:1028 (addDocument:
--         agent, club signatory and player lanes) and :1090 (supersede: a new
--         row copying the old one with version+1)
-- owner/writer: m26   lifecycle: version chain via supersedes / superseded_by
--         (old row kept, never edited except superseded_by + rev); removed_at
--         soft delete (set only by onPlayerDeleted on player-owned documents);
--         cap 200 live rows per transaction. STORES NO BYTES — evidence_ref
--         points at the canonical evidence vault.
-- mapping: id -> id (txd-*); transactionId -> transaction_id; documentType ->
--   document_type; visibility -> visibility (T_AND_S_ONLY is in the vocabulary
--   but no lane may write it); label -> label (≤120); version -> version;
--   owner{kind,id} -> owner_kind / owner_id (polymorphic: org_users(id) for
--     'agent', orgs(id) for 'club', players(id) for 'player'; no FK — the id is
--     nulled on player deletion); ownerPartyRole -> owner_party_role (null for
--     the agent); uploadedBy{kind,userId,name,orgId?} -> uploaded_by_*;
--   createdAt -> created_at; expiresAt -> expires_at (epoch ms; an unreadable
--     expiry reads as expired at read time); signedAt -> signed_at (reserved by
--     design §32, NEVER SET by any writer — kept nullable);
--   evidenceRef{kind:'verification_evidence',id} -> evidence_ref_kind /
--     evidence_ref_id (-> ver_evidence(id), 05; the uploader must own the
--     evidence record); supersedes -> supersedes_id; supersededBy ->
--     superseded_by_id; removedAt -> removed_at; keys.add{key,fp} ->
--     idempotency_keys (action 'add'; a superseding row has keys {});
--   rev/revAt/revBy -> rev / rev_at / rev_by_user_id / rev_by_name (bumped
--     with the role label by bumpTxRev); history[] -> transaction_document_history.
-- notes: read access is re-derived from room roles + visibility class on every
--   read; holding evidence_ref_id is not authority to download.
-- -----------------------------------------------------------------------------
CREATE TABLE transaction_documents (
  id                   TEXT PRIMARY KEY,
  transaction_id       TEXT NOT NULL REFERENCES agent_transactions(id) ON DELETE RESTRICT,
  document_type        TEXT NOT NULL CHECK (document_type IN ('representation_agreement_reference','compliance_consent_reference','guardian_evidence','mandate','term_sheet_draft','employment_contract_draft','club_document','regulatory_evidence','correspondence_attachment')),
  visibility           TEXT NOT NULL CHECK (visibility IN ('AGENT_PRIVATE','PLAYER_PRIVATE','ENGAGING_CLUB_PRIVATE','RELEASING_CLUB_PRIVATE','PLAYER_AGENT_SHARED','ENGAGING_AGENT_SHARED','RELEASING_AGENT_SHARED','ALL_TRANSACTION_PARTIES','T_AND_S_ONLY')),
  label                TEXT NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  owner_kind           TEXT NOT NULL CHECK (owner_kind IN ('agent','club','player')),
  owner_id             TEXT,                            -- polymorphic with owner_kind; no FK; nulled on player deletion
  owner_party_role     TEXT CHECK (owner_party_role IS NULL OR owner_party_role IN ('individual','engaging_entity','releasing_entity')),
  uploaded_by_kind     TEXT CHECK (uploaded_by_kind IN ('org','club_user','player')),
  uploaded_by_id       TEXT,
  uploaded_by_name     TEXT,                            -- snapshot; nulled on player deletion
  uploaded_by_org_id   TEXT,
  created_at           INTEGER NOT NULL,
  expires_at           INTEGER,
  signed_at            INTEGER,                         -- reserved; never written today
  evidence_ref_kind    TEXT CHECK (evidence_ref_kind IS NULL OR evidence_ref_kind IN ('verification_evidence')),
  evidence_ref_id      TEXT REFERENCES ver_evidence(id) ON DELETE RESTRICT,
  supersedes_id        TEXT REFERENCES transaction_documents(id) ON DELETE RESTRICT,
  superseded_by_id     TEXT REFERENCES transaction_documents(id) ON DELETE RESTRICT,
  removed_at           INTEGER,
  rev                  INTEGER NOT NULL DEFAULT 1,
  rev_at               INTEGER,
  rev_by_user_id       TEXT,
  rev_by_name          TEXT,                            -- snapshot or role label
  CHECK ((evidence_ref_kind IS NULL) = (evidence_ref_id IS NULL))
) STRICT;
CREATE INDEX transaction_documents_transaction ON transaction_documents(transaction_id, removed_at);
CREATE INDEX transaction_documents_supersedes ON transaction_documents(supersedes_id);

-- source: db.transactionDocuments[].history[]
-- actions: transaction_document_added, transaction_document_superseded
--   (transaction_document_removed is in the audit vocabulary but no code path
--   writes it: onPlayerDeleted sets removed_at without a history entry)
CREATE TABLE transaction_document_history (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES transaction_documents(id) ON DELETE RESTRICT,
  at           INTEGER NOT NULL,
  by_kind      TEXT CHECK (by_kind IN ('org','player','club_user','ts_reviewer','system')),
  by_id        TEXT,
  by_name      TEXT,
  by_role      TEXT,
  by_org_id    TEXT,
  action       TEXT NOT NULL,
  detail_json  TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX transaction_document_history_document ON transaction_document_history(document_id, at);


-- =============================================================================
-- not tables:
--   - PERMISSIONS / TIERS capability matrix (domains/agents/core/shared.mjs:165): code registry.
--   - VERIFICATION_STATES, FACETS, JURISDICTIONS, SCOPES, DISCLOSURE_KEYS,
--     TRANSACTION_STATUSES, ACTOR_TRANSITIONS / COMPLIANCE_TRANSITIONS,
--     ROOM_ROLES, DOCUMENT_TYPES, DOCUMENT_VISIBILITY + VISIBILITY_ROLES /
--     VISIBILITY_SIDE, NOTE_VISIBILITY, TIMELINE_AUDIENCES / ACTION_AUDIENCE,
--     HOLD/CANCEL/CLOSE_REASON_CODES, PENDING_REASONS, TRANSACTION_LIMITS,
--     REVIEW_KINDS/STATUSES, CONSENT_KINDS/STATUSES, POLICY_LEVEL_REASONS,
--     RULE_STATUSES, TEXT_STATUSES, CONTEXT_TYPE_SCOPES, SURFACES / RULE_ORDER /
--     DENY_CODES / CONTACT_ROUTING_MODES / HANDOFF_BLOCKERS (m27): enum
--     vocabularies encoded as CHECK constraints or derived at read time.
--   - SEEDED_POLICY_VERSIONS (domains/agents/compliance/policyVersions.mjs): code data; its rows ARE
--     migrated into jurisdiction_policies by step 2306 (the registry is the
--     seed, the table is the store).
--   - Verification provider (domains/agents/compliance/provider.mjs: 'none' / synthetic test
--     double), PROVIDER_STATES, FACET_METHOD: code; provider answers are
--     recorded only as facet provenance.
--   - Conflict engine evaluateConflict / evaluatePolicy / evaluateMinorGate /
--     consentSufficiency, m26 complianceStateFrom / statusForComplianceState /
--     partyRevisionOf / snapshotStaleness / offerReadiness, m27
--     agentSurfaceDecision / contactRouting / handoffBlockers /
--     duplicateTransactionOf: pure functions over the tables above.
--   - Derived values: effective facet state (STALE), effective agreement
--     status ('expired'), agreementGrantsAccess, regulatoryState projection,
--     consent status 'revoked', evaluation alias / requiredActions /
--     missingEvidence / ruleStatuses, transaction playerId / engagingOrgId /
--     releasingOrgId, timeline audience, staleness verdict, offer readiness,
--     handoff 'expired', room roles, audit feeds (domains/agents/{core,compliance,transactions}/audit.mjs).
--   - Rate-limit buckets (agent_profile_write, agent_affiliation_write,
--     agent_representation_request, compliance_*, transaction_*, ts_*,
--     opportunity_share, transaction_handoff, login_failure): in-memory.
--   - Reviewer sessions (createSession('ts_reviewer', id)): db.sessions,
--     01_identity.sql.
--   - Notifications emitted by these modules: db.notifications (elsewhere).
--   - recruitmentCases[].transactionHandoff and the transaction_handoff_*
--     history entries written by m27: belong to recruitment_cases
--     (02_recruitment.sql); only the transaction side (link_recruitment_case_id)
--     is here.
--   - Hooks objects (m24 hooks, m25 transactionHooks / transactionSeam /
--     integrationSeam, m27 seam holder): in-memory wiring.
-- =============================================================================
