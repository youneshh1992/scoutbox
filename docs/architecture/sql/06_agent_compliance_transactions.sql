-- =============================================================================
-- 06_agent_compliance_transactions.sql
-- ScoutBox target relational schema — Agent core (m24), Conflict & Compliance
-- Engine (m25), Agent Transaction Workspace (m26) and the m27 writes that land
-- on m24 records (opportunity shares; the recruitment-case handoff is on
-- recruitment_cases and belongs to 02_recruitment.sql).
--
-- Source collections (created by m182/migrations.mjs): agentProfiles,
-- agencyAffiliations, representationAgreements (step 2305, lines 391-393);
-- tsReviewers, jurisdictionPolicies, regulatoryReviews, regulatoryConsents,
-- complianceContexts (step 2306, lines 471-475); agentTransactions,
-- transactionRepresentations, transactionDocuments (step 2307, lines 547-549);
-- orgs.agencySettings (m24/index.mjs:443, no migration step).
--
-- Conventions: see ddl-conventions.md. All epoch-ms instants are INTEGER *_at;
-- all optimistic-concurrency tokens are rev / rev_at / rev_by_*; every
-- `keys.<action> {key, fp}` idempotency slot is NOT a column here but a row in
-- the shared `idempotency_keys` table (02_recruitment.sql): one row per
-- (owner table, owner record id, action, key, fp) — the mapping comment of each
-- table names the action values it uses. `fp` is payloadFingerprint(): the
-- sorted-key JSON of the request parts (m23/contact.mjs:337), not a hash.
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
-- source: db.tsReviewers   created at m25/index.mjs:92 (upsertReviewer); bootstrap
--         from TS_REVIEWER_BOOTSTRAP_* env (m25/index.mjs:99) or dev seed (:104)
-- owner/writer: m25 (tsRouter /reviewers, /reviewers/:id/revoke)
-- lifecycle: status active -> revoked (never deleted; revoked keeps the row and
--            its sessions are dropped). ≥1 active trust_safety_admin invariant
--            enforced by code (LAST_REVIEWER_ADMIN).
-- mapping: id -> id (natural, /^[a-z0-9][a-z0-9-]{2,39}$/i, operator-chosen);
--   name -> name (≤80); role -> role; status -> status;
--   secretHash -> secret_hash (scrypt string from hashPassword(); the plain
--     secret was NEVER stored — only its hash — so this is a rename, not a
--     hardening); createdAt -> created_at; createdBy{kind,userId,name} ->
--     created_by_kind / created_by_id / created_by_name (kind is 'system' for
--     bootstrap/dev seed, 'ts_reviewer' for an admin-created reviewer);
--   revokedAt -> revoked_at; revokedBy{id,name} -> revoked_by_id (self FK) /
--     revoked_by_name (snapshot); rev/revAt/revBy -> rev / rev_at /
--     rev_by_user_id / rev_by_name; history[] -> ts_reviewer_history.
-- notes: reviewer identity is the G-C0 attribution record; a reviewer row is
--   never removed. Login lockout is in-memory rate limiting (not a table).
-- -----------------------------------------------------------------------------
CREATE TABLE ts_reviewers (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('trust_safety_reviewer','trust_safety_admin')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  secret_hash      TEXT NOT NULL,                       -- scrypt string; plain secret never stored
  created_at       INTEGER NOT NULL,
  created_by_kind  TEXT CHECK (created_by_kind IN ('system','ts_reviewer')),
  created_by_id    TEXT,
  created_by_name  TEXT,                                -- snapshot
  revoked_at       INTEGER,
  revoked_by_id    TEXT REFERENCES ts_reviewers(id) ON DELETE RESTRICT,
  revoked_by_name  TEXT,                                -- snapshot
  rev              INTEGER NOT NULL DEFAULT 1,
  rev_at           INTEGER,
  rev_by_user_id   TEXT,
  rev_by_name      TEXT                                 -- snapshot
) STRICT;
CREATE INDEX ts_reviewers_status ON ts_reviewers(status);

-- source: db.tsReviewers[].history[]   (m25/index.mjs:66 hist())
-- actions: reviewer_created, reviewer_revoked
CREATE TABLE ts_reviewer_history (
  id           TEXT PRIMARY KEY,                        -- aud-*
  reviewer_id  TEXT NOT NULL REFERENCES ts_reviewers(id) ON DELETE RESTRICT,
  at           INTEGER NOT NULL,
  by_kind      TEXT CHECK (by_kind IN ('org','player','club_user','ts_reviewer','system')),
  by_id        TEXT,
  by_name      TEXT,
  by_role      TEXT,
  by_org_id    TEXT,
  action       TEXT NOT NULL,
  detail_json  TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX ts_reviewer_history_reviewer ON ts_reviewer_history(reviewer_id, at);


-- -----------------------------------------------------------------------------
-- source: db.jurisdictionPolicies   created at m25/index.mjs:220 (proposed via
--         POST /ts/compliance/policies) and m182/migrations.mjs:482 (seeded
--         from m25/policyVersions.mjs SEEDED_POLICY_VERSIONS)
-- owner/writer: m25   lifecycle: status proposed -> published (dual control:
--         approver must differ from proposer). Never deleted or edited after
--         publication; a later version is a new row with `supersedes`.
-- mapping: id -> id (natural 'jp-<regulator>-<ver>', /^jp-[a-z]{2,6}-[0-9a-z-]{2,20}$/i);
--   regulator -> regulator (≤20, 'UNKNOWN' default); jurisdiction -> jurisdiction;
--   policyVersion -> policy_version (int ≥1); supersedes -> supersedes_id (self FK;
--     the code does not validate the value today — the FK is new);
--   effectiveFrom/effectiveTo -> effective_from_date / effective_to_date (strict
--     date-only); status -> status; proposedBy{id,name,at} -> proposed_by_id /
--     proposed_by_name / proposed_at (all null on seeded rows);
--   approvedBy{id,name,at} -> approved_by_id / approved_by_name / approved_at;
--   publishedAt -> published_at; publishedBy[] -> jurisdiction_policy_publishers;
--   rules{ruleId: Rule} -> jurisdiction_policy_rules (+ _sources, _overrides);
--   createdAt -> created_at; rev/revAt/revBy -> rev / rev_at / rev_by_*;
--   history[] -> jurisdiction_policy_history.
-- notes: uniqueness of id enforced by code (POLICY_VERSION_EXISTS) and by the
--   PK. The in-force version per jurisdiction is derived at read time
--   (selectPolicyVersion: published, effective window covers now, highest
--   policyVersion wins) — not stored.
-- -----------------------------------------------------------------------------
CREATE TABLE jurisdiction_policies (
  id                   TEXT PRIMARY KEY,
  regulator            TEXT NOT NULL,
  jurisdiction         TEXT NOT NULL CHECK (length(jurisdiction) = 3),
  policy_version       INTEGER NOT NULL CHECK (policy_version >= 1),
  supersedes_id        TEXT REFERENCES jurisdiction_policies(id) ON DELETE RESTRICT,
  effective_from_date  TEXT NOT NULL CHECK (length(effective_from_date) = 10),
  effective_to_date    TEXT CHECK (effective_to_date IS NULL OR length(effective_to_date) = 10),
  status               TEXT NOT NULL CHECK (status IN ('proposed','published')),
  proposed_by_id       TEXT REFERENCES ts_reviewers(id) ON DELETE RESTRICT,
  proposed_by_name     TEXT,                            -- snapshot
  proposed_at          INTEGER,
  approved_by_id       TEXT REFERENCES ts_reviewers(id) ON DELETE RESTRICT,
  approved_by_name     TEXT,                            -- snapshot
  approved_at          INTEGER,
  published_at         INTEGER,
  created_at           INTEGER NOT NULL,
  rev                  INTEGER NOT NULL DEFAULT 1,
  rev_at               INTEGER,
  rev_by_user_id       TEXT,
  rev_by_name          TEXT                             -- snapshot
) STRICT;
CREATE INDEX jurisdiction_policies_jurisdiction_status ON jurisdiction_policies(jurisdiction, status);

-- source: db.jurisdictionPolicies[].publishedBy[]  (m25/index.mjs:239 — two
--         ts_reviewer entries [proposer, approver]; migrations.mjs:482 /
--         policyVersions.mjs:51 — one {kind:'system', id:'migration-2306', name})
-- mapping: array index -> position; kind -> by_kind; id -> by_id; name -> by_name
CREATE TABLE jurisdiction_policy_publishers (
  policy_id  TEXT NOT NULL REFERENCES jurisdiction_policies(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL CHECK (position >= 0),
  by_kind    TEXT NOT NULL CHECK (by_kind IN ('ts_reviewer','system')),
  by_id      TEXT NOT NULL,
  by_name    TEXT,                                      -- snapshot
  PRIMARY KEY (policy_id, position)
) STRICT;

-- source: db.jurisdictionPolicies[].rules{ruleId}   (m25/index.mjs:223 route;
--         m25/policyVersions.mjs:43 rule() for seeds)
-- mapping: key -> rule_id; ruleStatus -> rule_status; textStatus -> text_status;
--   note -> note (≤1000); effectiveFrom (rule-level, optional) -> effective_from_date;
--   params{} -> params_json: FREE-FORM BY DESIGN — each rule carries its own
--     parameter vocabulary (maxTermMonthsIndividual, permittedSets[], formula,
--     firstContractAge{}, exclusivityWindowMonths, activeLimbs[], …) and the
--     engine reads them by name per rule (m25/policy.mjs, m25/conflict.mjs);
--     a column per parameter would change with every policy publication.
--   sourceRef[] -> jurisdiction_policy_rule_sources; overrides[] ->
--   jurisdiction_policy_rule_overrides.
-- notes: ruleStatusAt() (PENDING_IMPLEMENTATION reads ACTIVE after its
--   effectiveFrom) is derived, not stored.
CREATE TABLE jurisdiction_policy_rules (
  policy_id            TEXT NOT NULL REFERENCES jurisdiction_policies(id) ON DELETE CASCADE,
  rule_id              TEXT NOT NULL,
  rule_status          TEXT NOT NULL CHECK (rule_status IN ('ACTIVE','SUSPENDED','PARTIALLY_SUSPENDED','JURISDICTION_OVERRIDE','PENDING_IMPLEMENTATION','UNDER_LEGAL_REVIEW','UNKNOWN')),
  text_status          TEXT CHECK (text_status IS NULL OR text_status IN ('CURRENT','CURRENT_BUT_SUSPENDED','CURRENT_WITH_PARTIAL_SUSPENSION','UNCERTAIN_OPERATIVE_STATUS','HISTORICAL','SUPERSEDED','ANNOUNCED')),
  note                 TEXT,
  effective_from_date  TEXT CHECK (effective_from_date IS NULL OR length(effective_from_date) = 10),
  params_json          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params_json)),
  PRIMARY KEY (policy_id, rule_id)
) STRICT;

-- source: db.jurisdictionPolicies[].rules{}.sourceRef[]  ({source, version,
--         effectiveDate, retrievedDate}; m25/policyVersions.mjs:31 src())
-- mapping: index -> position; source -> source; version -> version (free text,
--   e.g. 'edition approved 10 Dec 2024'); effectiveDate -> effective_date;
--   retrievedDate -> retrieved_date. Route validation requires source and
--   retrievedDate only (m25/index.mjs:208).
CREATE TABLE jurisdiction_policy_rule_sources (
  policy_id       TEXT NOT NULL,
  rule_id         TEXT NOT NULL,
  position        INTEGER NOT NULL CHECK (position >= 0),
  source          TEXT NOT NULL,
  version         TEXT,
  effective_date  TEXT CHECK (effective_date IS NULL OR length(effective_date) = 10),
  retrieved_date  TEXT NOT NULL CHECK (length(retrieved_date) = 10),
  PRIMARY KEY (policy_id, rule_id, position),
  FOREIGN KEY (policy_id, rule_id) REFERENCES jurisdiction_policy_rules(policy_id, rule_id) ON DELETE CASCADE
) STRICT;

-- source: db.jurisdictionPolicies[].rules{}.overrides[]  ({jurisdiction, scope,
--         overrideRuleId}; seeds FIFA-12.8/12.9/12.10 -> ENG-6.3/6.4/6.5)
-- mapping: jurisdiction -> jurisdiction; scope -> scope ('national' only
--   written); overrideRuleId -> override_rule_id (a rule id in another policy
--   version; resolved by name at evaluation time, no FK).
CREATE TABLE jurisdiction_policy_rule_overrides (
  policy_id         TEXT NOT NULL,
  rule_id           TEXT NOT NULL,
  jurisdiction      TEXT NOT NULL CHECK (length(jurisdiction) = 3),
  scope             TEXT NOT NULL CHECK (scope IN ('national')),
  override_rule_id  TEXT NOT NULL,
  PRIMARY KEY (policy_id, rule_id, jurisdiction),
  FOREIGN KEY (policy_id, rule_id) REFERENCES jurisdiction_policy_rules(policy_id, rule_id) ON DELETE CASCADE
) STRICT;

-- source: db.jurisdictionPolicies[].history[]
-- actions: policy_version_proposed, policy_version_published
CREATE TABLE jurisdiction_policy_history (
  id           TEXT PRIMARY KEY,
  policy_id    TEXT NOT NULL REFERENCES jurisdiction_policies(id) ON DELETE RESTRICT,
  at           INTEGER NOT NULL,
  by_kind      TEXT CHECK (by_kind IN ('org','player','club_user','ts_reviewer','system')),
  by_id        TEXT,
  by_name      TEXT,
  by_role      TEXT,
  by_org_id    TEXT,
  action       TEXT NOT NULL,
  detail_json  TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX jurisdiction_policy_history_policy ON jurisdiction_policy_history(policy_id, at);


-- -----------------------------------------------------------------------------
-- source: db.agentProfiles   created at m24/index.mjs:234 (POST /org/agent/profile)
-- owner/writer: m24 (profile, facet submit); m25 (facet recheck, attributed
--         review decision writes the facet; migration 2306 adds the
--         domestic_authorisation container)
-- lifecycle: no status, no soft delete. One profile per user (profileOf =
--         find by userId; enforced by code — unique index is new but safe).
-- mapping: id -> id (agp-*); userId -> user_id; agencyOrgId -> agency_org_id;
--   displayName -> display_name (≤80); declared.fifaLicenceNumber ->
--   declared_fifa_licence_number (≤40; a DECLARATION, never a verified
--   licence); declared.jurisdictions[] -> agent_profile_declared_jurisdictions;
--   facets{} -> agent_profile_facets; policyVersion -> policy_version;
--   createdAt/updatedAt -> created_at / updated_at; rev/revAt/revBy -> rev /
--   rev_at / rev_by_user_id / rev_by_name; keys{} -> never populated for a
--   profile (always {}): no idempotency_keys rows; history[] -> agent_profile_history.
-- notes: personal data (licence number, submitted references). Admin oversight
--   route withholds the number and references. regulatoryState.* in the
--   projection is derived (effectiveFacetState + verificationGap).
-- -----------------------------------------------------------------------------
CREATE TABLE agent_profiles (
  id                            TEXT PRIMARY KEY,
  user_id                       TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  agency_org_id                 TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  display_name                  TEXT NOT NULL,
  declared_fifa_licence_number  TEXT,                   -- personal data; declared, not verified
  policy_version                INTEGER NOT NULL DEFAULT 1,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL,
  rev                           INTEGER NOT NULL DEFAULT 1,
  rev_at                        INTEGER,
  rev_by_user_id                TEXT,
  rev_by_name                   TEXT                    -- snapshot
) STRICT;
CREATE UNIQUE INDEX agent_profiles_user ON agent_profiles(user_id);       -- enforced by code today (profileOf)
CREATE INDEX agent_profiles_agency ON agent_profiles(agency_org_id);

-- source: db.agentProfiles[].declared.jurisdictions[]  (m24/index.mjs:228, values
--         filtered to JURISDICTIONS INT|ENG|USA)
-- mapping: each element -> one row (member_association)
CREATE TABLE agent_profile_declared_jurisdictions (
  profile_id          TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  member_association  TEXT NOT NULL CHECK (member_association IN ('INT','ENG','USA')),
  PRIMARY KEY (profile_id, member_association)
) STRICT;

-- source: db.agentProfiles[].facets  — facets.fifa_licence: Facet (m24/shared.mjs:55
--         emptyFacet), facets.national_registration / domestic_authorisation /
--         minors_authorisation: {MA: Facet} (m24/index.mjs:301, m25/index.mjs:268
--         setFacet, m25/index.mjs:907 review decision)
-- owner/writer: m24 submit, m25 recheck + attributed review
-- lifecycle: state is overwritten on each submission / recheck / decision;
--         STALE is DERIVED (VERIFIED past recheck_at, m24/shared.mjs:77) and is
--         also a storable state from the synthetic provider (STALE answer maps
--         to VERIFIED on write, provider.mjs:75, so stored STALE never occurs
--         from code today; kept in the CHECK because VERIFICATION_STATES lists it).
-- mapping: object key (facet name) -> facet; MA key -> member_association —
--     for fifa_licence the source memberAssociation is null and the facet is
--     FIFA-level, which the vocabulary names 'INT' (JURISDICTIONS, and
--     policy.mjs:243 already addresses minors_authorisation under 'INT'), so
--     fifa_licence rows store member_association = 'INT' (lossless: the value
--     is implied by the facet); a STRICT composite PK cannot hold NULL.
--   state -> state; reference -> reference (≤60, personal data: a licence /
--     registration number); memberAssociation -> member_association (see above);
--   provenance{provider,kind,at,reviewerId?,reviewId?} -> provenance_provider /
--     provenance_kind / provenance_at / provenance_reviewer_id /
--     provenance_review_id (-> regulatory_reviews(id); no FK: reviews reference
--     profiles, cycle); submittedAt -> submitted_at; verifiedAt -> verified_at;
--   recheckAt -> recheck_at; note -> note; staleNotifiedAt -> stale_notified_at
--     (m25/index.mjs:364, only on a VERIFIED-turned-STALE facet).
-- notes: an empty default fifa_licence facet (state UNVERIFIED, all null) is a
--   row too, so the profile always has its fifa_licence row; empty MA maps
--   ({}) have no rows. One review item per facet in PENDING/IN_REVIEW is
--   enforced by code (openReviewFor).
CREATE TABLE agent_profile_facets (
  profile_id              TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  facet                   TEXT NOT NULL CHECK (facet IN ('fifa_licence','national_registration','domestic_authorisation','minors_authorisation')),
  member_association      TEXT NOT NULL CHECK (length(member_association) = 3),   -- 'INT' for fifa_licence
  state                   TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (state IN ('UNVERIFIED','PENDING','VERIFIED','STALE','INACTIVE','MANUAL_REVIEW_REQUIRED')),
  reference               TEXT,                         -- personal data
  provenance_provider     TEXT CHECK (provenance_provider IS NULL OR provenance_provider IN ('none','local-synthetic-test-provider','attributed_review')),
  provenance_kind         TEXT CHECK (provenance_kind IS NULL OR provenance_kind IN ('none','synthetic','human_review')),
  provenance_at           INTEGER,
  provenance_reviewer_id  TEXT REFERENCES ts_reviewers(id) ON DELETE RESTRICT,
  provenance_review_id    TEXT,                         -- -> regulatory_reviews(id), no FK (cycle)
  submitted_at            INTEGER,
  verified_at             INTEGER,
  recheck_at              INTEGER,
  note                    TEXT,
  stale_notified_at       INTEGER,
  PRIMARY KEY (profile_id, facet, member_association),
  CHECK (facet <> 'fifa_licence' OR member_association = 'INT'),
  CHECK (facet = 'fifa_licence' OR member_association <> 'INT' OR facet = 'minors_authorisation')
) STRICT;

-- source: db.agentProfiles[].history[]  (m24/index.mjs:53 hist; m25 recheck/review)
-- actions: agent_profile_created, agent_profile_updated, agent_verification_submitted,
--   agent_verification_state_changed, agent_facet_rechecked
CREATE TABLE agent_profile_history (
  id           TEXT PRIMARY KEY,
  profile_id   TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  at           INTEGER NOT NULL,
  by_kind      TEXT CHECK (by_kind IN ('org','player','club_user','ts_reviewer','system')),
  by_id        TEXT,
  by_name      TEXT,
  by_role      TEXT,
  by_org_id    TEXT,
  action       TEXT NOT NULL,
  detail_json  TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX agent_profile_history_profile ON agent_profile_history(profile_id, at);


-- -----------------------------------------------------------------------------
-- source: db.agencyAffiliations   created at m24/index.mjs:81 (bootstrap first
--         member as admin), :374 (POST /org/agent/agency/team) and
--         m182/migrations.mjs:405 (step 2305: every existing agency user)
-- owner/writer: m24   lifecycle: active while started_at <= now and ended_at is
--         null/future (affiliationActive); ended via /team/:userId/end (sets
--         ended_at + ended_reason, also soft-removes the org user). Never deleted.
-- mapping: id -> id (aff-*, or aff-mig2305-<base36>-<n> for migrated rows);
--   agencyOrgId -> agency_org_id; userId -> user_id; tiers[] ->
--   agency_affiliation_tiers; startedAt -> started_at; endedAt -> ended_at;
--   endedReason -> ended_reason (≤40, free text, default 'left');
--   createdAt -> created_at; rev/revAt/revBy -> rev / rev_at / rev_by_*;
--   keys.create {key,fp} -> idempotency_keys (action 'create', fp over
--     {name lowercased, tiers}; migrated rows have no keys);
--   history[] -> agency_affiliation_history.
-- notes: one ACTIVE affiliation per (user, agency) enforced by code
--   (MEMBER_ALREADY_AFFILIATED); the partial unique index below is new and
--   approximates "active" as ended_at IS NULL. ≥1 active agency_admin per
--   agency (LAST_ADMIN) is code-enforced only.
-- -----------------------------------------------------------------------------
CREATE TABLE agency_affiliations (
  id              TEXT PRIMARY KEY,
  agency_org_id   TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  user_id         TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  ended_reason    TEXT,
  created_at      INTEGER NOT NULL,
  rev             INTEGER NOT NULL DEFAULT 1,
  rev_at          INTEGER,
  rev_by_user_id  TEXT,
  rev_by_name     TEXT                                  -- snapshot
) STRICT;
CREATE INDEX agency_affiliations_agency ON agency_affiliations(agency_org_id);
CREATE UNIQUE INDEX agency_affiliations_active_member ON agency_affiliations(user_id, agency_org_id) WHERE ended_at IS NULL;   -- new; code enforces "one active"

-- source: db.agencyAffiliations[].tiers[]  (normaliseTiers: TIERS, de-duplicated)
-- Junction, not JSON: tiers are queried as a set on every request (can(),
-- admins count, LAST_ADMIN / SELF_PROMOTION invariants, licensed_agent filters).
CREATE TABLE agency_affiliation_tiers (
  affiliation_id  TEXT NOT NULL REFERENCES agency_affiliations(id) ON DELETE CASCADE,
  tier            TEXT NOT NULL CHECK (tier IN ('licensed_agent','agency_admin','analyst','assistant','finance')),
  PRIMARY KEY (affiliation_id, tier)
) STRICT;

-- source: db.agencyAffiliations[].history[]
-- actions: agency_affiliation_created, agency_affiliation_updated, agency_affiliation_ended
CREATE TABLE agency_affiliation_history (
  id              TEXT PRIMARY KEY,
  affiliation_id  TEXT NOT NULL REFERENCES agency_affiliations(id) ON DELETE RESTRICT,
  at              INTEGER NOT NULL,
  by_kind         TEXT CHECK (by_kind IN ('org','player','club_user','ts_reviewer','system')),
  by_id           TEXT,
  by_name         TEXT,
  by_role         TEXT,
  by_org_id       TEXT,
  action          TEXT NOT NULL,
  detail_json     TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX agency_affiliation_history_affiliation ON agency_affiliation_history(affiliation_id, at);


-- -----------------------------------------------------------------------------
-- source: db.representationAgreements   created at m24/index.mjs:598
--         (POST /org/agent/clients/request) and m182/migrations.mjs:432
--         (step 2305: legacy mirror of every db.representations row)
-- owner/writer: m24 (request / terminate / client confirm, decline, terminate,
--         dispute / sharing+disclosure); m25 (dispute resolution by attributed
--         review); m27 (opportunityShares[], history); m24 onPlayerDeleted
--         (tombstone).
-- lifecycle: status proposed -> active | declined | disputed; active ->
--         terminated_by_client | terminated_by_agent | disputed; disputed ->
--         active (reinstated) | terminated_by_client (dispute_upheld);
--         'expired' is DERIVED (active past end_at) but migration 2305 stores
--         it for legacy rows. Soft delete: subject_removed_at (player deletion:
--         dispute_reason nulled, legacy name nulled, proposed -> declined).
-- mapping: id -> id (rep-*, rep-mig2305-… for legacy); agentUserId ->
--   agent_user_id (NULL on legacy agency-level rows); agencyOrgId ->
--   agency_org_id (nullable: migration copies r.agencyOrgId ?? null);
--   clientKind/clientId -> client_kind / client_id (polymorphic pair, no FK:
--     only 'player' today; a player row may be removed while this record stays
--     as an id-only tombstone); isRegulatoryMinor -> is_regulatory_minor;
--   jurisdiction -> jurisdiction (NULL on legacy); scope[] -> agreement_scopes;
--   exclusive -> exclusive; termMonths -> term_months (1..24, NULL legacy);
--   startAt/endAt -> start_at / end_at; status -> status; proposedAt ->
--   proposed_at; confirmedAt -> confirmed_at; confirmedBy{kind,id} ->
--   confirmed_by_kind / confirmed_by_id; declinedAt -> declined_at;
--   terminatedAt -> terminated_at; terminatedBy -> terminated_by;
--   terminationReasonCode -> termination_reason_code (≤40 free text; values
--     written: agent_ended default, client_ended, dispute_upheld, or caller's);
--   disputedAt -> disputed_at; disputeReason -> dispute_reason (≤300, moderated;
--     nulled on subject removal); disputeResolvedAt -> dispute_resolved_at;
--   disputeResolution{reviewId,outcome} -> dispute_resolution_review_id (->
--     regulatory_reviews(id), no FK: cycle) / dispute_resolution_outcome;
--   shareWithAgencyStaff -> share_with_agency_staff;
--   disclosure{clubPresence,contactRouting,trialVisibility} ->
--     disclosure_club_presence / disclosure_contact_routing /
--     disclosure_trial_visibility (absent object == all false, m24/shared.mjs:389);
--   documents[] -> agreement_documents; legacy{fromRepresentationId,
--     regulatoryStatus,representativeName} -> legacy_from_representation_id /
--     legacy_regulatory_status / legacy_representative_name (legacy IS NULL
--     <=> all three NULL; from_representation_id points at the retired M13 F10
--     db.representations row, which has no table in this schema);
--   opportunityShares[] -> agreement_opportunity_shares (m27);
--   policyVersion -> policy_version; policyVersions[] -> agreement_policy_versions
--     (absent on legacy rows = no rows); keys.request/terminate/confirm/
--     decline/dispute {key,fp} -> idempotency_keys (actions 'request',
--     'terminate', 'confirm', 'decline', 'dispute'); keys.expiryNotifiedAt ->
--     expiry_notified_at (a TIMESTAMP stored under keys by m24/index.mjs:193,
--     not an idempotency key — promoted to a column); createdAt -> created_at;
--   rev/revAt/revBy -> rev / rev_at / rev_by_user_id / rev_by_name;
--   history[] -> agreement_history; subjectRemovedAt -> subject_removed_at.
-- notes: one proposed/active/disputed agreement per (agent, client) and the
--   30-day re-request cooldown are enforced by code on EFFECTIVE status
--   (requestConflict); a unique index on stored status would wrongly block a
--   re-request after a stored-'active' row expired, so none is created.
--   Minors refused at request time (isAdult) — is_regulatory_minor is always
--   false today. Agreement terms carry no fee anywhere (P-5).
-- -----------------------------------------------------------------------------
CREATE TABLE representation_agreements (
  id                             TEXT PRIMARY KEY,
  agent_user_id                  TEXT REFERENCES org_users(id) ON DELETE RESTRICT,   -- NULL = legacy agency-level row
  agency_org_id                  TEXT REFERENCES orgs(id) ON DELETE RESTRICT,
  client_kind                    TEXT NOT NULL CHECK (client_kind IN ('player')),
  client_id                      TEXT NOT NULL,          -- polymorphic with client_kind: players(id); no FK (tombstoned, not cascaded)
  is_regulatory_minor            INTEGER NOT NULL DEFAULT 0 CHECK (is_regulatory_minor IN (0,1)),
  jurisdiction                   TEXT CHECK (jurisdiction IS NULL OR jurisdiction IN ('INT','ENG','USA')),
  exclusive                      INTEGER NOT NULL DEFAULT 0 CHECK (exclusive IN (0,1)),
  term_months                    INTEGER CHECK (term_months IS NULL OR (term_months >= 1 AND term_months <= 24)),
  start_at                       INTEGER,
  end_at                         INTEGER,
  status                         TEXT NOT NULL CHECK (status IN ('proposed','active','declined','expired','terminated_by_client','terminated_by_agent','disputed')),
  proposed_at                    INTEGER,
  confirmed_at                   INTEGER,
  confirmed_by_kind              TEXT CHECK (confirmed_by_kind IS NULL OR confirmed_by_kind IN ('player')),
  confirmed_by_id                TEXT,
  declined_at                    INTEGER,
  terminated_at                  INTEGER,
  terminated_by                  TEXT CHECK (terminated_by IS NULL OR terminated_by IN ('agent','client','trust_safety')),
  termination_reason_code        TEXT,
  disputed_at                    INTEGER,
  dispute_reason                 TEXT,                   -- personal data (client's free text); nulled on subject removal
  dispute_resolved_at            INTEGER,
  dispute_resolution_review_id   TEXT,                   -- -> regulatory_reviews(id), no FK (cycle)
  dispute_resolution_outcome     TEXT CHECK (dispute_resolution_outcome IS NULL OR dispute_resolution_outcome IN ('reinstated','ended')),
  share_with_agency_staff        INTEGER NOT NULL DEFAULT 0 CHECK (share_with_agency_staff IN (0,1)),
  disclosure_club_presence       INTEGER NOT NULL DEFAULT 0 CHECK (disclosure_club_presence IN (0,1)),
  disclosure_contact_routing     INTEGER NOT NULL DEFAULT 0 CHECK (disclosure_contact_routing IN (0,1)),
  disclosure_trial_visibility    INTEGER NOT NULL DEFAULT 0 CHECK (disclosure_trial_visibility IN (0,1)),
  legacy_from_representation_id  TEXT,                   -- retired M13 F10 db.representations id; no table
  legacy_regulatory_status       TEXT CHECK (legacy_regulatory_status IS NULL OR legacy_regulatory_status IN ('not_regulated_record')),
  legacy_representative_name     TEXT,                   -- snapshot; personal data; nulled on subject removal
  policy_version                 INTEGER NOT NULL DEFAULT 1,
  expiry_notified_at             INTEGER,
  created_at                     INTEGER NOT NULL,
  rev                            INTEGER NOT NULL DEFAULT 1,
  rev_at                         INTEGER,
  rev_by_user_id                 TEXT,
  rev_by_name                    TEXT,                   -- snapshot
  subject_removed_at             INTEGER,
  CHECK ((legacy_from_representation_id IS NULL) = (legacy_regulatory_status IS NULL))
) STRICT;
CREATE INDEX representation_agreements_agency_agent ON representation_agreements(agency_org_id, agent_user_id);
CREATE INDEX representation_agreements_client ON representation_agreements(client_kind, client_id);
CREATE INDEX representation_agreements_agent_client ON representation_agreements(agent_user_id, client_id);
CREATE INDEX representation_agreements_status ON representation_agreements(status);

-- source: db.representationAgreements[].scope[]  (normaliseScope: SCOPES, ≥1,
--         default ['employment']; legacy mapped from contracts_only/commercial_only)
-- Junction, not JSON: scope membership is tested on every regulated act
-- (representationScopeProblem, m27 SURFACES.scopes).
CREATE TABLE agreement_scopes (
  agreement_id  TEXT NOT NULL REFERENCES representation_agreements(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL CHECK (scope IN ('employment','transfer','commercial','other_services')),
  PRIMARY KEY (agreement_id, scope)
) STRICT;

-- source: db.representationAgreements[].policyVersions[]  (m24/index.mjs:589:
--         ids of the policy set in force when the approach was authorised)
CREATE TABLE agreement_policy_versions (
  agreement_id       TEXT NOT NULL REFERENCES representation_agreements(id) ON DELETE CASCADE,
  policy_version_id  TEXT NOT NULL REFERENCES jurisdiction_policies(id) ON DELETE RESTRICT,
  PRIMARY KEY (agreement_id, policy_version_id)
) STRICT;

-- source: db.representationAgreements[].documents[]  ({id, label, addedAt};
--         projected at m24/shared.mjs:459, initialised [] at :604 and in
--         migration 2305:440)
-- notes: NO WRITER EXISTS in this build — every row is []. Table kept because
--   the projection reads the shape; expect it empty after migration.
--   -- dead field today (no writer); migrated as empty.
CREATE TABLE agreement_documents (
  id            TEXT PRIMARY KEY,
  agreement_id  TEXT NOT NULL REFERENCES representation_agreements(id) ON DELETE CASCADE,
  label         TEXT,
  added_at      INTEGER
) STRICT;

-- source: db.representationAgreements[].opportunityShares[]  created at
--         m27/index.mjs:460 (POST /org/agent/clients/:id/opportunities/:oppId/share)
-- owner/writer: m27 (share, withdraw)   lifecycle: withdrawn_at soft marker;
--         never deleted; cap 200 per agreement (MAX_OPPORTUNITY_SHARES).
-- mapping: id -> id (aos-*); opportunityId -> opportunity_id + via ->
--   via: a POLYMORPHIC pair — the board (m12/journeys.mjs:837/848) yields
--   via 'opportunity' (-> opportunities(id), 04) or 'open_trial' (an open
--   trial day row, 04), so no FK; title/orgName/deadline -> title / org_name /
--   deadline_date (snapshots of the board row at share time); note -> note
--   (≤300, plainShared); sharedAt -> shared_at; sharedBy{kind,userId,name} ->
--   shared_by_kind / shared_by_user_id / shared_by_name (name is the agent's
--   displayName, snapshot); withdrawnAt -> withdrawn_at; keys.share{key,fp} ->
--   idempotency_keys (action 'share', fp over {opportunityId, note});
--   rev/revAt -> rev / rev_at (no revBy on a share).
-- notes: one un-withdrawn share per (agreement, opportunity) enforced by code
--   (OPPORTUNITY_ALREADY_SHARED); partial unique index below is new.
CREATE TABLE agreement_opportunity_shares (
  id                 TEXT PRIMARY KEY,
  agreement_id       TEXT NOT NULL REFERENCES representation_agreements(id) ON DELETE CASCADE,
  via                TEXT CHECK (via IS NULL OR via IN ('opportunity','open_trial')),
  opportunity_id     TEXT NOT NULL,                      -- polymorphic with via; no FK
  title              TEXT,                               -- snapshot
  org_name           TEXT,                               -- snapshot
  deadline_date      TEXT CHECK (deadline_date IS NULL OR length(deadline_date) = 10),   -- snapshot
  note               TEXT,
  shared_at          INTEGER NOT NULL,
  shared_by_kind     TEXT CHECK (shared_by_kind IN ('org')),
  shared_by_user_id  TEXT,
  shared_by_name     TEXT,                               -- snapshot
  withdrawn_at       INTEGER,
  rev                INTEGER NOT NULL DEFAULT 1,
  rev_at             INTEGER
) STRICT;
CREATE INDEX agreement_opportunity_shares_agreement ON agreement_opportunity_shares(agreement_id, shared_at);
CREATE UNIQUE INDEX agreement_opportunity_shares_live ON agreement_opportunity_shares(agreement_id, opportunity_id) WHERE withdrawn_at IS NULL;   -- new; code enforces

-- source: db.representationAgreements[].history[]  (m24 hist; m25 review
--         decision; m27/index.mjs:472/505 opportunity_shared / _withdrawn;
--         migration 2305 representation_requested with detail.legacy)
-- actions: representation_requested, representation_confirmed,
--   representation_rejected, representation_terminated, representation_disputed,
--   representation_sharing_changed, opportunity_shared, opportunity_share_withdrawn
-- notes: on player deletion, by{kind:'player'} rows are reduced to
--   by_id/by_name NULL (m24/index.mjs:896).
CREATE TABLE agreement_history (
  id            TEXT PRIMARY KEY,
  agreement_id  TEXT NOT NULL REFERENCES representation_agreements(id) ON DELETE RESTRICT,
  at            INTEGER NOT NULL,
  by_kind       TEXT CHECK (by_kind IN ('org','player','club_user','ts_reviewer','system')),
  by_id         TEXT,
  by_name       TEXT,
  by_role       TEXT,
  by_org_id     TEXT,
  action        TEXT NOT NULL,
  detail_json   TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX agreement_history_agreement ON agreement_history(agreement_id, at);


-- -----------------------------------------------------------------------------
-- source: db.orgs[].agencySettings  {jurisdictions[], description}  written at
--         m24/index.mjs:443 (PATCH /org/agent/agency/settings); absent until
--         first write (read as {jurisdictions:[], description:''})
-- owner/writer: m24   lifecycle: one optional row per agency org; no delete.
-- mapping: (org) -> org_id; description -> description (≤300, moderated);
--   jurisdictions[] -> org_agency_jurisdictions.
-- notes: KNOWN DEFECT — m25/index.mjs:254 and :370 read `req.org.settings
--   ?.jurisdictions`, a field nobody writes, instead of `agencySettings`;
--   so the agency's declared jurisdictions never reach the compliance
--   overview/policy routes today. The data is still real and migrated.
-- -----------------------------------------------------------------------------
CREATE TABLE org_agency_settings (
  org_id       TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  description  TEXT NOT NULL DEFAULT ''
) STRICT;

-- source: db.orgs[].agencySettings.jurisdictions[]  (de-duplicated, JURISDICTIONS)
CREATE TABLE org_agency_jurisdictions (
  org_id              TEXT NOT NULL REFERENCES org_agency_settings(org_id) ON DELETE CASCADE,
  member_association  TEXT NOT NULL CHECK (member_association IN ('INT','ENG','USA')),
  PRIMARY KEY (org_id, member_association)
) STRICT;


-- -----------------------------------------------------------------------------
-- source: db.regulatoryReviews   created at m25/index.mjs:283 (createReview:
--         facetNeedsReview, representationDisputed, declare/conflict routes,
--         createApproachReview, supersede) ; m26/index.mjs:779/792 (via
--         compliance.createReview) ; m182/migrations.mjs:497/510 (step 2306)
-- owner/writer: m25 (tsRouter start/resolve/cancel/supersede; context close
--         cancels open items); m26 creates via the seam.
-- lifecycle: PENDING -> IN_REVIEW -> APPROVED | REJECTED; PENDING/IN_REVIEW ->
--         CANCELLED; APPROVED/REJECTED -> SUPERSEDED (new row with supersedes).
--         Never deleted; decision object retained untouched after supersession.
-- mapping: id -> id (rrv-*, rrv-mig2306-…); kind -> kind; status -> status;
--   agencyOrgId -> agency_org_id; agentUserId -> agent_user_id;
--   subject{} -> per-kind columns PLUS subject_json (the object verbatim):
--     verification_facet {profileId,userId,facet,memberAssociation,referenceHash}
--       -> subject_profile_id / subject_user_id / subject_facet /
--          subject_member_association / subject_reference_hash (KNOWN DEFECT:
--          the value is String(reference.length), the reference's LENGTH, not
--          a hash — m25/index.mjs:299, migrations.mjs:499; kept as written);
--     representation_dispute {agreementId} -> subject_agreement_id;
--     representation_declared / conflict_evaluation {contextId,
--       representationId?, partyRole, transactionId?} -> subject_context_id
--       (-> compliance_contexts(id), no FK: contexts reference reviews),
--       subject_representation_id (crp-* or txr-*; no FK), subject_party_role,
--       subject_transaction_id (-> agent_transactions(id), no FK);
--     conflict_evaluation approach {approach:true, playerId, jurisdiction}
--       (m25/index.mjs:1014) -> subject_is_approach / subject_player_id /
--       subject_jurisdiction.
--   reasons[] -> regulatory_review_reasons; policyVersions[] ->
--   regulatory_review_policy_versions; snapshot -> snapshot_json (an
--     immutable copy of the engine result at request time, by design; read
--     only as a whole by the reviewer view); requestedAt -> requested_at;
--   requestedBy{kind,userId,name,role?} -> requested_by_*; startedAt ->
--   started_at; startedBy{id,name,role} -> started_by_id / started_by_name /
--   started_by_role; decidedAt -> decided_at; decision{} -> decision_* columns:
--     reviewerId/reviewerName/reviewerRole -> decision_reviewer_id /
--     decision_reviewer_name / decision_reviewer_role; outcome ->
--     decision_outcome; reasonCode -> decision_reason_code (≤60; 'cancelled'
--     on cancel); reason -> decision_reason (≤1000); evidenceRefs[] ->
--     regulatory_review_evidence_refs; decision.policyVersions -> derived, not
--     stored (always a copy of r.policyVersions at decision time); at ->
--     decision_at; priorState/resultingState -> decision_prior_state_json /
--     decision_resulting_state_json (small per-kind variant objects
--     {status, facetState | agreementStatus | contextOutcome,
--     representationStatus, note?}; read only by the T&S audit projection;
--     deferred normalisation — would need one nullable column per kind);
--   supersedes -> supersedes_id; supersededBy -> superseded_by_id;
--   keys.resolve{key,fp} -> idempotency_keys (action 'resolve');
--   rev/revAt/revBy -> rev / rev_at / rev_by_*; history[] -> regulatory_review_history.
-- notes: "one open review per subject" is enforced by code (openReviewFor /
--   migration dedupe) — not expressible as one unique index across the
--   per-kind subject columns, so none is created. Reviewer identity is
--   attributed (G-C0); pre-P5.6C rows with 'shared_admin_key' attribution do
--   not exist in this store (the note in REVIEWER_LEGACY_NOTE is prose).
-- -----------------------------------------------------------------------------
CREATE TABLE regulatory_reviews (
  id                             TEXT PRIMARY KEY,
  kind                           TEXT NOT NULL CHECK (kind IN ('verification_facet','representation_declared','conflict_evaluation','representation_dispute')),
  status                         TEXT NOT NULL CHECK (status IN ('PENDING','IN_REVIEW','APPROVED','REJECTED','CANCELLED','SUPERSEDED')),
  agency_org_id                  TEXT REFERENCES orgs(id) ON DELETE RESTRICT,
  agent_user_id                  TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  -- subject (per kind) --
  subject_profile_id             TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  subject_user_id                TEXT,
  subject_facet                  TEXT CHECK (subject_facet IS NULL OR subject_facet IN ('fifa_licence','national_registration','domestic_authorisation','minors_authorisation')),
  subject_member_association     TEXT CHECK (subject_member_association IS NULL OR length(subject_member_association) = 3),
  subject_reference_hash         TEXT,                   -- defect: holds String(reference.length)
  subject_agreement_id           TEXT REFERENCES representation_agreements(id) ON DELETE RESTRICT,
  subject_context_id             TEXT,                   -- -> compliance_contexts(id), no FK (cycle)
  subject_representation_id      TEXT,                   -- crp-* / txr-*, no FK
  subject_party_role             TEXT CHECK (subject_party_role IS NULL OR subject_party_role IN ('individual','engaging_entity','releasing_entity')),
  subject_transaction_id         TEXT,                   -- -> agent_transactions(id), no FK (cycle)
  subject_is_approach            INTEGER NOT NULL DEFAULT 0 CHECK (subject_is_approach IN (0,1)),
  subject_player_id              TEXT,                   -- players(id); no FK (approach subject may be removed)
  subject_jurisdiction           TEXT CHECK (subject_jurisdiction IS NULL OR length(subject_jurisdiction) = 3),
  subject_json                   TEXT NOT NULL CHECK (json_valid(subject_json)),   -- verbatim subject object (per-kind shape by design)
  -- request / progress --
  snapshot_json                  TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),   -- engine result at request time (immutable snapshot by design)
  requested_at                   INTEGER NOT NULL,
  requested_by_kind              TEXT CHECK (requested_by_kind IN ('org','player','club_user','ts_reviewer','system')),
  requested_by_id                TEXT,
  requested_by_name              TEXT,                   -- snapshot
  requested_by_role              TEXT,
  started_at                     INTEGER,
  started_by_id                  TEXT REFERENCES ts_reviewers(id) ON DELETE RESTRICT,
  started_by_name                TEXT,                   -- snapshot
  started_by_role                TEXT,
  decided_at                     INTEGER,
  -- decision --
  decision_reviewer_id           TEXT REFERENCES ts_reviewers(id) ON DELETE RESTRICT,
  decision_reviewer_name         TEXT,                   -- snapshot
  decision_reviewer_role         TEXT,
  decision_outcome               TEXT CHECK (decision_outcome IS NULL OR decision_outcome IN ('APPROVED','REJECTED','CANCELLED')),
  decision_reason_code           TEXT,
  decision_reason                TEXT,
  decision_at                    INTEGER,
  decision_prior_state_json      TEXT CHECK (decision_prior_state_json IS NULL OR json_valid(decision_prior_state_json)),
  decision_resulting_state_json  TEXT CHECK (decision_resulting_state_json IS NULL OR json_valid(decision_resulting_state_json)),
  supersedes_id                  TEXT REFERENCES regulatory_reviews(id) ON DELETE RESTRICT,
  superseded_by_id               TEXT REFERENCES regulatory_reviews(id) ON DELETE RESTRICT,
  rev                            INTEGER NOT NULL DEFAULT 1,
  rev_at                         INTEGER,
  rev_by_user_id                 TEXT,
  rev_by_name                    TEXT,                   -- snapshot
  CHECK ((decision_outcome IS NULL) = (decision_reviewer_id IS NULL))
) STRICT;
CREATE INDEX regulatory_reviews_status_requested ON regulatory_reviews(status, requested_at);
CREATE INDEX regulatory_reviews_agency ON regulatory_reviews(agency_org_id, agent_user_id);
CREATE INDEX regulatory_reviews_subject_facet ON regulatory_reviews(kind, subject_profile_id, subject_facet, subject_member_association);
CREATE INDEX regulatory_reviews_subject_agreement ON regulatory_reviews(subject_agreement_id);
CREATE INDEX regulatory_reviews_subject_context ON regulatory_reviews(subject_context_id);

-- source: db.regulatoryReviews[].reasons[]  — reason objects from m25/policy.mjs
--         reasonOf() / m25/conflict.mjs reason(): {code, ruleId, ruleStatus,
--         regulator, jurisdiction, policyVersion, ...extra}; migration/hook rows
--         carry only {code, ruleId, ruleStatus, policyVersion}.
-- mapping: index -> position; code -> code; ruleId -> rule_id; ruleStatus ->
--   rule_status; regulator -> regulator; jurisdiction -> jurisdiction;
--   policyVersion -> policy_version_id (a jurisdiction_policies id; no FK —
--   seeded reasons may name a version absent from a restored snapshot);
--   every other key (facet, memberAssociation, state, agentUserId, partyRoles[],
--   consentKind, detail, overrideRuleId, viaConnectedAgent, …) -> extra_json
--   (free-form by design: per-reason-code extras).
CREATE TABLE regulatory_review_reasons (
  review_id          TEXT NOT NULL REFERENCES regulatory_reviews(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL CHECK (position >= 0),
  code               TEXT NOT NULL,
  rule_id            TEXT,
  rule_status        TEXT,
  regulator          TEXT,
  jurisdiction       TEXT,
  policy_version_id  TEXT,
  extra_json         TEXT CHECK (extra_json IS NULL OR json_valid(extra_json)),
  PRIMARY KEY (review_id, position)
) STRICT;

-- source: db.regulatoryReviews[].policyVersions[]  (policy set ids in force at request)
CREATE TABLE regulatory_review_policy_versions (
  review_id          TEXT NOT NULL REFERENCES regulatory_reviews(id) ON DELETE CASCADE,
  policy_version_id  TEXT NOT NULL REFERENCES jurisdiction_policies(id) ON DELETE RESTRICT,
  PRIMARY KEY (review_id, policy_version_id)
) STRICT;

-- source: db.regulatoryReviews[].decision.evidenceRefs[]  (m25/index.mjs:866:
--         free strings ≤200, ≤10; an APPROVED decision needs ≥1)
-- mapping: index -> position; element -> ref (free text; NOT a ver_evidence id
--   by contract — the reviewer cites whatever evidence reference they hold)
CREATE TABLE regulatory_review_evidence_refs (
  review_id  TEXT NOT NULL REFERENCES regulatory_reviews(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL CHECK (position >= 0 AND position < 10),
  ref        TEXT NOT NULL,
  PRIMARY KEY (review_id, position)
) STRICT;

-- source: db.regulatoryReviews[].history[]
-- actions: regulatory_review_requested, regulatory_review_started,
--   regulatory_review_resolved, regulatory_review_cancelled, regulatory_review_superseded
-- notes: the T&S decision audit (m25/audit.mjs reviewerDecisionRows) is a
--   projection over these rows' detail (outcome, reasonCode, evidenceRefs,
--   policyVersions, priorState, resultingState, rev).
CREATE TABLE regulatory_review_history (
  id           TEXT PRIMARY KEY,
  review_id    TEXT NOT NULL REFERENCES regulatory_reviews(id) ON DELETE RESTRICT,
  at           INTEGER NOT NULL,
  by_kind      TEXT CHECK (by_kind IN ('org','player','club_user','ts_reviewer','system')),
  by_id        TEXT,
  by_name      TEXT,
  by_role      TEXT,
  by_org_id    TEXT,
  action       TEXT NOT NULL,
  detail_json  TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX regulatory_review_history_review ON regulatory_review_history(review_id, at);


-- -----------------------------------------------------------------------------
-- source: db.complianceContexts   created at m25/index.mjs:547
--         (POST /org/agent/compliance/contexts) and m25/index.mjs:1046
--         (transactionSeam.openContext, one per agent transaction)
-- owner/writer: m25 (parties, representations, evaluate, close, review
--         decisions, policy publication flag); m26 through the seam
--         (project() rewrites parties/representations from the transaction;
--         evaluate; closeContext on CANCELLED/CLOSED); m25 onPlayerDeleted
--         (party removed + player actors anonymised).
-- lifecycle: status open -> closed; never deleted.
-- mapping: id -> id (ctx-*); agencyOrgId -> agency_org_id; agentUserId ->
--   agent_user_id; type -> type; jurisdictions[] -> compliance_context_jurisdictions;
--   parties[] -> compliance_context_parties; representations[] ->
--   compliance_context_representations; otherServices[] -> NOT MIGRATED
--     (-- dead field: initialised [] and never written by any route; the engine
--     reads it); interests[] -> NOT MIGRATED (-- dead field: same);
--   resolvedFacts[] -> compliance_context_resolved_facts; evaluations[] ->
--   compliance_evaluations; reEvaluationPending -> re_evaluation_pending;
--   reviewRejectedAt -> review_rejected_at; status -> status; openedAt ->
--   opened_at; closedAt -> closed_at; origin -> origin ('transaction' when
--     opened by the seam, absent otherwise -> NULL); transactionId ->
--     transaction_id (-> agent_transactions(id), no FK: transactions reference
--     contexts; 1:1, partial unique index); keys.create{key,fp} ->
--     idempotency_keys (action 'create'; seam-opened contexts have none);
--   rev/revAt/revBy -> rev / rev_at / rev_by_*; history[] -> compliance_context_history.
-- notes: personal to the opening agent (ownContext conceals colleagues').
--   For origin='transaction' the parties/representations rows are a PROJECTION
--   rebuilt from transaction_parties / transaction_representations on every
--   evaluation (m25/index.mjs:1063); the transaction rows are the truth.
-- -----------------------------------------------------------------------------
CREATE TABLE compliance_contexts (
  id                     TEXT PRIMARY KEY,
  agency_org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  agent_user_id          TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  type                   TEXT NOT NULL CHECK (type IN ('employment_contract','transfer','loan','other_services')),
  status                 TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  re_evaluation_pending  INTEGER NOT NULL DEFAULT 0 CHECK (re_evaluation_pending IN (0,1)),
  review_rejected_at     INTEGER,
  origin                 TEXT CHECK (origin IS NULL OR origin IN ('transaction')),
  transaction_id         TEXT,                          -- -> agent_transactions(id), no FK (cycle); 1:1
  opened_at              INTEGER NOT NULL,
  closed_at              INTEGER,
  rev                    INTEGER NOT NULL DEFAULT 1,
  rev_at                 INTEGER,
  rev_by_user_id         TEXT,
  rev_by_name            TEXT,                          -- snapshot
  CHECK ((origin IS NULL) = (transaction_id IS NULL))
) STRICT;
CREATE INDEX compliance_contexts_agency_agent ON compliance_contexts(agency_org_id, agent_user_id);
CREATE INDEX compliance_contexts_status ON compliance_contexts(status);
CREATE UNIQUE INDEX compliance_contexts_transaction ON compliance_contexts(transaction_id) WHERE transaction_id IS NOT NULL;

-- source: db.complianceContexts[].jurisdictions[]  (upper-cased 3-letter codes,
--         de-duplicated; not restricted to JURISDICTIONS — an unencoded MA is
--         reported as missing by applicablePolicySet)
CREATE TABLE compliance_context_jurisdictions (
  context_id          TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE CASCADE,
  member_association  TEXT NOT NULL CHECK (length(member_association) = 3),
  PRIMARY KEY (context_id, member_association)
) STRICT;

-- source: db.complianceContexts[].parties[]  created at m25/index.mjs:502/507
--         (resolveParty, id cpt-*) or copied from a transaction's parties by
--         transactionSeam.project (m25/index.mjs:1064, id txp-*)
-- mapping: id -> id; partyRole -> party_role; subjectKind/subjectId ->
--   subject_kind / subject_id (polymorphic: players(id) | orgs(id); no FK —
--   a removed player stays as an id); addedAt -> added_at; removed -> removed;
--   removedAt -> removed_at (set by onPlayerDeleted, or copied from the
--   transaction party).
-- notes: one un-removed party per (context, partyRole) enforced by code
--   (CONTEXT_PARTY_EXISTS); partial unique index is new.
CREATE TABLE compliance_context_parties (
  id            TEXT PRIMARY KEY,
  context_id    TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE CASCADE,
  party_role    TEXT NOT NULL CHECK (party_role IN ('individual','engaging_entity','releasing_entity')),
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('player','club')),
  subject_id    TEXT NOT NULL,                          -- polymorphic with subject_kind; no FK
  added_at      INTEGER NOT NULL,
  removed       INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0,1)),
  removed_at    INTEGER
) STRICT;
CREATE INDEX compliance_context_parties_context ON compliance_context_parties(context_id);
CREATE UNIQUE INDEX compliance_context_parties_live_role ON compliance_context_parties(context_id, party_role) WHERE removed = 0;   -- new; code enforces

-- source: db.complianceContexts[].representations[]  created at
--         m25/index.mjs:635 (pending_review, declared-only) / :647 (verified)
--         (id crp-*), or projected from transaction_representations
--         (m25/index.mjs:1065, id txr-*)
-- owner/writer: m25 (declare, withdraw, review decision); seam project()
-- lifecycle: status verified | pending_review | withdrawn (withdrawn is terminal)
-- mapping: id -> id; agentUserId -> agent_user_id; partyRole -> party_role;
--   agreementId -> agreement_id; status -> status; declaredOnly -> declared_only;
--   reviewId -> review_id; declaredAt -> declared_at; firstActAt -> first_act_at
--   (null for a review-verified declaration until the agent acts);
--   withdrawnAt -> withdrawn_at; verifiedByReviewId -> verified_by_review_id;
--   verifiedAt -> verified_at; keys.declare{key,fp} -> idempotency_keys
--   (action 'declare', fp over {partyRole, agreementId}).
-- notes: one non-withdrawn representation per (context, partyRole, agent)
--   enforced by code; partial unique index is new. Projected rows (txr-*)
--   carry no declared_at / keys; declared_at is therefore nullable.
CREATE TABLE compliance_context_representations (
  id                     TEXT PRIMARY KEY,
  context_id             TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE CASCADE,
  agent_user_id          TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  party_role             TEXT NOT NULL CHECK (party_role IN ('individual','engaging_entity','releasing_entity')),
  agreement_id           TEXT REFERENCES representation_agreements(id) ON DELETE RESTRICT,
  status                 TEXT NOT NULL CHECK (status IN ('verified','pending_review','withdrawn')),
  declared_only          INTEGER NOT NULL DEFAULT 0 CHECK (declared_only IN (0,1)),
  review_id              TEXT REFERENCES regulatory_reviews(id) ON DELETE SET NULL,
  declared_at            INTEGER,
  first_act_at           INTEGER,
  withdrawn_at           INTEGER,
  verified_by_review_id  TEXT REFERENCES regulatory_reviews(id) ON DELETE SET NULL,
  verified_at            INTEGER
) STRICT;
CREATE INDEX compliance_context_representations_context ON compliance_context_representations(context_id);
CREATE UNIQUE INDEX compliance_context_representations_live ON compliance_context_representations(context_id, party_role, agent_user_id) WHERE status <> 'withdrawn';   -- new; code enforces

-- source: db.complianceContexts[].resolvedFacts[]  (m25/index.mjs:953: reason
--         codes an APPROVED conflict_evaluation review settled; de-duplicated)
CREATE TABLE compliance_context_resolved_facts (
  context_id  TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE CASCADE,
  code        TEXT NOT NULL CHECK (code IN ('OTHER_SERVICES_PRESUMPTION','INTEREST_DECLARED','REPRESENTATION_UNVERIFIED')),
  PRIMARY KEY (context_id, code)
) STRICT;

-- source: db.complianceContexts[].evaluations[]  APPEND-ONLY, pushed at
--         m25/index.mjs:476 (evaluateAndRecord) with the m25/conflict.mjs
--         evaluateConflict() result spread in.
-- owner/writer: m25 only (m26 asks through the seam). Never edited or removed.
-- mapping: (no source id) -> id = <context_id> || '#' || position, where
--     position is the 1-based array index — this is exactly the evaluationId
--     m26 records on its compliance snapshot (m26/index.mjs:205), so the
--     snapshot's reference becomes a real key; array index -> position;
--   outcome -> outcome; alias -> derived, not stored ('PERMITTED_WITH_CONSENT'
--     iff outcome is the long form); reasons[] -> compliance_evaluation_reasons;
--   consentsOutstanding[] -> compliance_evaluation_consents_outstanding;
--   requiredActions[] -> derived, not stored (requiredActionsFor(outcome,
--     reasons, consentsOutstanding) is a pure function of stored data);
--   missingEvidence[] -> derived, not stored (filter of reasons by code);
--   ruleStatuses{} -> derived, not stored (reasons rule_id -> rule_status);
--   policyVersions[] -> compliance_evaluation_policy_versions; evaluatedAt ->
--   evaluated_at; inputHash -> input_hash (sha256 hex of the canonical engine
--   input — a fingerprint, not a secret); snapshotOf{parties[],representations[],
--   proposed} -> snapshot_of_json (immutable snapshot of the inputs' identity
--   at evaluation time, by design; read as a whole).
CREATE TABLE compliance_evaluations (
  id                TEXT PRIMARY KEY,                   -- '<ctx-id>#<position>'
  context_id        TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE RESTRICT,
  position          INTEGER NOT NULL CHECK (position >= 1),
  outcome           TEXT NOT NULL CHECK (outcome IN ('CLEAR','PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED','PROHIBITED_CONFLICT','MANUAL_REGULATORY_REVIEW_REQUIRED','INSUFFICIENT_DATA')),
  evaluated_at      INTEGER NOT NULL,
  input_hash        TEXT NOT NULL CHECK (length(input_hash) = 64),
  snapshot_of_json  TEXT NOT NULL CHECK (json_valid(snapshot_of_json))
) STRICT;
CREATE UNIQUE INDEX compliance_evaluations_context_position ON compliance_evaluations(context_id, position);

-- source: db.complianceContexts[].evaluations[].reasons[]  (m25/conflict.mjs reason())
-- mapping: as regulatory_review_reasons (same object shape).
CREATE TABLE compliance_evaluation_reasons (
  evaluation_id      TEXT NOT NULL REFERENCES compliance_evaluations(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL CHECK (position >= 0),
  code               TEXT NOT NULL,
  rule_id            TEXT,
  rule_status        TEXT,
  regulator          TEXT,
  jurisdiction       TEXT,
  policy_version_id  TEXT,
  extra_json         TEXT CHECK (extra_json IS NULL OR json_valid(extra_json)),
  PRIMARY KEY (evaluation_id, position)
) STRICT;

-- source: db.complianceContexts[].evaluations[].consentsOutstanding[]
--         ({partyRole, agentUserId, consentKind, reasonCode}; de-duplicated per
--         (partyRole, consentKind))
CREATE TABLE compliance_evaluation_consents_outstanding (
  evaluation_id  TEXT NOT NULL REFERENCES compliance_evaluations(id) ON DELETE CASCADE,
  party_role     TEXT NOT NULL CHECK (party_role IN ('individual','engaging_entity','releasing_entity')),
  consent_kind   TEXT NOT NULL CHECK (consent_kind IN ('dual_representation')),
  agent_user_id  TEXT,
  reason_code    TEXT NOT NULL,
  PRIMARY KEY (evaluation_id, party_role, consent_kind)
) STRICT;

-- source: db.complianceContexts[].evaluations[].policyVersions[]
CREATE TABLE compliance_evaluation_policy_versions (
  evaluation_id      TEXT NOT NULL REFERENCES compliance_evaluations(id) ON DELETE CASCADE,
  policy_version_id  TEXT NOT NULL REFERENCES jurisdiction_policies(id) ON DELETE RESTRICT,
  PRIMARY KEY (evaluation_id, policy_version_id)
) STRICT;

-- source: db.complianceContexts[].history[]
-- actions: compliance_context_opened, compliance_context_party_added,
--   compliance_context_party_removed, compliance_representation_declared,
--   compliance_representation_verified, compliance_representation_withdrawn,
--   compliance_context_evaluated, compliance_context_policy_changed,
--   compliance_context_closed
CREATE TABLE compliance_context_history (
  id           TEXT PRIMARY KEY,
  context_id   TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE RESTRICT,
  at           INTEGER NOT NULL,
  by_kind      TEXT CHECK (by_kind IN ('org','player','club_user','ts_reviewer','system')),
  by_id        TEXT,
  by_name      TEXT,
  by_role      TEXT,
  by_org_id    TEXT,
  action       TEXT NOT NULL,
  detail_json  TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX compliance_context_history_context ON compliance_context_history(context_id, at);


-- -----------------------------------------------------------------------------
-- source: db.regulatoryConsents (kind <> 'revocation')   created at
--         m25/index.mjs:728 (requestDualRepresentationConsent — from the
--         context route and from m26 /agent/transactions/:id/consents/request)
-- owner/writer: m25 (request; player/club grant, decline); m25 onPlayerDeleted
--         anonymises player actors.
-- lifecycle: status requested -> granted | declined. 'revoked' is DERIVED: a
--         granted consent is revoked iff a regulatory_consent_revocations row
--         names it (consentStatusOf). Rows are never edited after the answer
--         except for keys/rev; never deleted.
-- TWO TABLES, not one with kind: the source keeps revocation rows in the same
--   array (kind 'revocation') but they have a different shape (of, at, by; no
--   status, rev, keys, particulars, policyVersions), a different lifecycle
--   (a pure append-only fact) and every reader filters them out
--   (consentById, consentsFor, engineConsentsFor). The ledger property —
--   "the granted row is never edited" — is exactly what a separate
--   revocations table with a UNIQUE consent_id expresses. Both share the
--   rcs-* id namespace.
-- mapping: id -> id (rcs-*); kind -> kind (only dual_representation written;
--   the other CONSENT_KINDS are defined vocabulary); contextId -> context_id;
--   agentUserId -> agent_user_id; agencyOrgId -> agency_org_id; partyRole ->
--   party_role; subject{kind,id} -> subject_kind / subject_id (polymorphic:
--   players(id) | orgs(id), no FK); regarding[] -> regulatory_consent_regarding;
--   status -> status; requestedAt -> requested_at; requestedBy -> requested_by_*;
--   grantedAt -> granted_at; grantedBy{kind,userId,name,orgId?,signatory?} ->
--   granted_by_kind / granted_by_id / granted_by_name / granted_by_org_id /
--   granted_by_signatory (true for a club signatory; absent for a player ->
--   NULL); declinedAt -> declined_at; declinedBy -> declined_by_*;
--   particulars{fullParticularsProvided,legalAdviceOffered,proposedFeeDisclosed,
--     acknowledged{particulars,legalAdvice,at}|null} -> full_particulars_provided /
--     legal_advice_offered / proposed_fee_disclosed / acknowledged_particulars /
--     acknowledged_legal_advice / acknowledged_at (acknowledged null -> the
--     three NULL);
--   policyVersions[] -> regulatory_consent_policy_versions; ruleIds[] ->
--   regulatory_consent_rule_ids; keys.request/grant/decline/revoke {key,fp} ->
--   idempotency_keys (actions 'request','grant','decline','revoke' — note the
--   revoke key lives on the CONSENT row, m25/index.mjs:763); rev/revAt/revBy ->
--   rev / rev_at / rev_by_*; history[] -> regulatory_consent_history.
-- notes: one requested/granted consent per (context, agent, partyRole, kind)
--   enforced by code (CONSENT_ALREADY_REQUESTED, on effective status) —
--   partial unique on stored status would also hold since revocation does not
--   change stored status, but a revoked-then-re-requested consent would then
--   be refused by the index while the code allows it; so index only.
-- -----------------------------------------------------------------------------
CREATE TABLE regulatory_consents (
  id                         TEXT PRIMARY KEY,
  kind                       TEXT NOT NULL CHECK (kind IN ('dual_representation','agency_performance','guardian_approach','guardian_agreement','legal_advice_ack')),
  context_id                 TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE RESTRICT,
  agent_user_id              TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  agency_org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  party_role                 TEXT NOT NULL CHECK (party_role IN ('individual','engaging_entity','releasing_entity')),
  subject_kind               TEXT NOT NULL CHECK (subject_kind IN ('player','club')),
  subject_id                 TEXT NOT NULL,             -- polymorphic with subject_kind; no FK
  status                     TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','granted','declined')),
  requested_at               INTEGER NOT NULL,
  requested_by_kind          TEXT CHECK (requested_by_kind IN ('org')),
  requested_by_id            TEXT,
  requested_by_name          TEXT,                      -- snapshot
  granted_at                 INTEGER,
  granted_by_kind            TEXT CHECK (granted_by_kind IS NULL OR granted_by_kind IN ('player','club_user')),
  granted_by_id              TEXT,
  granted_by_name            TEXT,                      -- snapshot; nulled on player deletion
  granted_by_org_id          TEXT,
  granted_by_signatory       INTEGER CHECK (granted_by_signatory IS NULL OR granted_by_signatory IN (0,1)),
  declined_at                INTEGER,
  declined_by_kind           TEXT CHECK (declined_by_kind IS NULL OR declined_by_kind IN ('player','club_user')),
  declined_by_id             TEXT,
  declined_by_name           TEXT,                      -- snapshot
  declined_by_org_id         TEXT,
  full_particulars_provided  INTEGER NOT NULL DEFAULT 0 CHECK (full_particulars_provided IN (0,1)),
  legal_advice_offered       INTEGER NOT NULL DEFAULT 0 CHECK (legal_advice_offered IN (0,1)),
  proposed_fee_disclosed     INTEGER NOT NULL DEFAULT 0 CHECK (proposed_fee_disclosed IN (0,1)),
  acknowledged_particulars   INTEGER CHECK (acknowledged_particulars IS NULL OR acknowledged_particulars IN (0,1)),
  acknowledged_legal_advice  INTEGER CHECK (acknowledged_legal_advice IS NULL OR acknowledged_legal_advice IN (0,1)),
  acknowledged_at            INTEGER,
  rev                        INTEGER NOT NULL DEFAULT 1,
  rev_at                     INTEGER,
  rev_by_user_id             TEXT,
  rev_by_name                TEXT                       -- snapshot
) STRICT;
CREATE INDEX regulatory_consents_context ON regulatory_consents(context_id, kind);
CREATE INDEX regulatory_consents_subject ON regulatory_consents(subject_kind, subject_id, kind);
CREATE INDEX regulatory_consents_agency_agent ON regulatory_consents(agency_org_id, agent_user_id);

-- source: db.regulatoryConsents[].regarding[]  (the other un-removed party roles
--         in the context at request time)
CREATE TABLE regulatory_consent_regarding (
  consent_id  TEXT NOT NULL REFERENCES regulatory_consents(id) ON DELETE CASCADE,
  party_role  TEXT NOT NULL CHECK (party_role IN ('individual','engaging_entity','releasing_entity')),
  PRIMARY KEY (consent_id, party_role)
) STRICT;

-- source: db.regulatoryConsents[].policyVersions[]  (ids of the policy set in
--         force at request; consentSufficiency requires one ACTIVE deciding
--         version among them)
CREATE TABLE regulatory_consent_policy_versions (
  consent_id         TEXT NOT NULL REFERENCES regulatory_consents(id) ON DELETE CASCADE,
  policy_version_id  TEXT NOT NULL REFERENCES jurisdiction_policies(id) ON DELETE RESTRICT,
  PRIMARY KEY (consent_id, policy_version_id)
) STRICT;

-- source: db.regulatoryConsents[].ruleIds[]  ([rule.ruleId] — the deciding
--         dual-representation rule, e.g. 'ENG-6.3' or 'FIFA-12.8')
CREATE TABLE regulatory_consent_rule_ids (
  consent_id  TEXT NOT NULL REFERENCES regulatory_consents(id) ON DELETE CASCADE,
  rule_id     TEXT NOT NULL,
  PRIMARY KEY (consent_id, rule_id)
) STRICT;

-- source: db.regulatoryConsents (kind = 'revocation')   created at
--         m25/index.mjs:760 ({id, kind:'revocation', of, contextId, agentUserId,
--         agencyOrgId, partyRole, subject, at, by, history[]})
-- owner/writer: m25 consentAnswer('revoke')   lifecycle: append-only fact; never edited.
-- mapping: id -> id (rcs-*); kind -> implied by the table; of -> consent_id
--   (UNIQUE: a consent can be revoked once — code refuses a second revoke
--   because effective status is already 'revoked'); contextId -> context_id;
--   agentUserId -> agent_user_id; agencyOrgId -> agency_org_id; partyRole ->
--   party_role; subject{kind,id} -> subject_kind / subject_id (copied from the
--   consent); at -> revoked_at; by{kind,userId,name,orgId?} -> by_kind / by_id /
--   by_name / by_org_id (player actors anonymised on deletion);
--   history[] -> regulatory_consent_history rows with revocation_id set (the
--   revocation's single history entry is a second copy of the
--   regulatory_consent_revoked entry also appended to the consent).
CREATE TABLE regulatory_consent_revocations (
  id             TEXT PRIMARY KEY,
  consent_id     TEXT NOT NULL REFERENCES regulatory_consents(id) ON DELETE RESTRICT,
  context_id     TEXT NOT NULL REFERENCES compliance_contexts(id) ON DELETE RESTRICT,
  agent_user_id  TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  agency_org_id  TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  party_role     TEXT NOT NULL CHECK (party_role IN ('individual','engaging_entity','releasing_entity')),
  subject_kind   TEXT NOT NULL CHECK (subject_kind IN ('player','club')),
  subject_id     TEXT NOT NULL,                         -- polymorphic; no FK
  revoked_at     INTEGER NOT NULL,
  by_kind        TEXT CHECK (by_kind IN ('player','club_user')),
  by_id          TEXT,
  by_name        TEXT,                                  -- snapshot; nulled on player deletion
  by_org_id      TEXT
) STRICT;
CREATE UNIQUE INDEX regulatory_consent_revocations_consent ON regulatory_consent_revocations(consent_id);   -- enforced by code today (effective status)

-- source: db.regulatoryConsents[].history[]  (both consent rows and revocation rows)
-- actions: regulatory_consent_requested, regulatory_consent_granted,
--   regulatory_consent_declined, regulatory_consent_revoked
-- mapping: consent_id is the consent the entry belongs to; revocation_id is set
--   only for entries that lived on a revocation row's own history[].
CREATE TABLE regulatory_consent_history (
  id             TEXT PRIMARY KEY,
  consent_id     TEXT NOT NULL REFERENCES regulatory_consents(id) ON DELETE RESTRICT,
  revocation_id  TEXT REFERENCES regulatory_consent_revocations(id) ON DELETE RESTRICT,
  at             INTEGER NOT NULL,
  by_kind        TEXT CHECK (by_kind IN ('org','player','club_user','ts_reviewer','system')),
  by_id          TEXT,
  by_name        TEXT,
  by_role        TEXT,
  by_org_id      TEXT,
  action         TEXT NOT NULL,
  detail_json    TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX regulatory_consent_history_consent ON regulatory_consent_history(consent_id, at);


-- -----------------------------------------------------------------------------
-- source: db.agentTransactions   created at m26/index.mjs:594
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
--         (m26/transaction.mjs:122/145). Never deleted; ARCHIVED is read-only.
-- mapping: id -> id (atx-*); agencyOrgId -> agency_org_id; agentUserId ->
--   agent_user_id; type -> type; jurisdictions[] -> agent_transaction_jurisdictions;
--   status -> status; parties[] -> transaction_parties; contextId -> context_id
--   (1:1 with compliance_contexts, set at creation); compliance{} (snapshot,
--   m26/index.mjs:204) -> compliance_evaluation_id (either a compliance_evaluations
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
--     m26/index.mjs:104; rev_by_user_id is therefore omitted: always null);
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

-- source: db.agentTransactions[].parties[]  created at m26/index.mjs:494/499
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

-- source: db.agentTransactions[].parties[].history[]  (m26/index.mjs:602/648/674/1177/1266)
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

-- source: db.agentTransactions[].notes[]  created at m26/index.mjs:1120 (addNote;
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

-- source: db.agentTransactions[].linkedThreads[]  created at m26/index.mjs:1222
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

-- source: db.agentTransactions[].terms.versions[]  created at m26/index.mjs:957
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

-- source: db.agentTransactions[].history[]  (m26/index.mjs hist on the tx; all lanes)
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
--   transaction_status_changed {from:x,to:x} (m26/index.mjs:978/1239).
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
-- source: db.transactionRepresentations   created at m26/index.mjs:784
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
-- source: db.transactionDocuments   created at m26/index.mjs:1028 (addDocument:
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
--   - PERMISSIONS / TIERS capability matrix (m24/shared.mjs:165): code registry.
--   - VERIFICATION_STATES, FACETS, JURISDICTIONS, SCOPES, DISCLOSURE_KEYS,
--     TRANSACTION_STATUSES, ACTOR_TRANSITIONS / COMPLIANCE_TRANSITIONS,
--     ROOM_ROLES, DOCUMENT_TYPES, DOCUMENT_VISIBILITY + VISIBILITY_ROLES /
--     VISIBILITY_SIDE, NOTE_VISIBILITY, TIMELINE_AUDIENCES / ACTION_AUDIENCE,
--     HOLD/CANCEL/CLOSE_REASON_CODES, PENDING_REASONS, TRANSACTION_LIMITS,
--     REVIEW_KINDS/STATUSES, CONSENT_KINDS/STATUSES, POLICY_LEVEL_REASONS,
--     RULE_STATUSES, TEXT_STATUSES, CONTEXT_TYPE_SCOPES, SURFACES / RULE_ORDER /
--     DENY_CODES / CONTACT_ROUTING_MODES / HANDOFF_BLOCKERS (m27): enum
--     vocabularies encoded as CHECK constraints or derived at read time.
--   - SEEDED_POLICY_VERSIONS (m25/policyVersions.mjs): code data; its rows ARE
--     migrated into jurisdiction_policies by step 2306 (the registry is the
--     seed, the table is the store).
--   - Verification provider (m25/provider.mjs: 'none' / synthetic test
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
--     handoff 'expired', room roles, audit feeds (m24/m25/m26 audit.mjs).
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
