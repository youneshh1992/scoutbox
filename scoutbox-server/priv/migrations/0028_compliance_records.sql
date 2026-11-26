-- 0028_compliance_records: compliance contexts and their evaluations, regulatory reviews and consents (with revocations) become typed tables

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
  UNIQUE (id, context_id),
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
  snapshot_evaluation_id  TEXT,
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
  resolve_key  TEXT CHECK (resolve_key IS NULL OR (length(resolve_key) > 0 AND length(resolve_key) <= 64)),
  resolve_fp  TEXT CHECK ((resolve_fp IS NULL OR length(resolve_fp) <= 4000) AND ((resolve_key IS NULL) = (resolve_fp IS NULL))),
  rev  INTEGER NOT NULL CHECK (rev >= 1),
  rev_at  INTEGER,
  rev_by_id  TEXT CHECK (rev_by_id IS NULL OR (length(rev_by_id) > 0 AND length(rev_by_id) <= 80)),
  rev_by_name  TEXT CHECK (rev_by_name IS NULL OR length(rev_by_name) <= 200),
  CHECK ((decision_outcome IS NULL) = (decision_reviewer_id IS NULL)),
  CHECK (snapshot_evaluation_id IS NULL OR snapshot_outcome IS NOT NULL),
  CHECK (snapshot_evaluation_id IS NULL OR subject_context_id IS NOT NULL),
  CHECK ((started_at IS NULL) = (started_by_id IS NULL)),
  CHECK ((decided_at IS NOT NULL) = (decision_outcome IS NOT NULL OR status = 'CANCELLED')),
  CHECK (decision_outcome IS NOT NULL OR status IN ('PENDING','IN_REVIEW','CANCELLED')),
  CHECK (decision_outcome IS NULL OR decision_outcome = status OR (status = 'SUPERSEDED' AND decision_outcome <> 'CANCELLED')),
  FOREIGN KEY (snapshot_evaluation_id, subject_context_id) REFERENCES compliance_evaluations(id, context_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX regulatory_reviews_queue ON regulatory_reviews(status, requested_at);
CREATE UNIQUE INDEX regulatory_reviews_superseded_once ON regulatory_reviews(supersedes_id) WHERE supersedes_id IS NOT NULL;
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
