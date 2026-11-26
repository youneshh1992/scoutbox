-- 0027_compliance_policies: Trust & Safety reviewers and jurisdiction policy versions become typed tables; the seeded policy versions are inserted

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

INSERT INTO jurisdiction_policies (id, regulator, jurisdiction, policy_version, supersedes_id, effective_from_date, effective_to_date, status, proposed_by_id, proposed_by_name, proposed_at, approved_by_id, approved_by_name, approved_at, published_at, created_at, rev, rev_at, rev_by_name, rev_by_id) VALUES ('jp-fifa-2025-1', 'FIFA', 'INT', 1, NULL, '2025-01-01', NULL, 'published', NULL, NULL, NULL, NULL, NULL, NULL, (__NOW__ + 0), (__NOW__ + 0), 1, (__NOW__ + 0), NULL, NULL) ON CONFLICT(id) DO UPDATE SET regulator = excluded.regulator, jurisdiction = excluded.jurisdiction, policy_version = excluded.policy_version, supersedes_id = excluded.supersedes_id, effective_from_date = excluded.effective_from_date, effective_to_date = excluded.effective_to_date, status = excluded.status, proposed_by_id = excluded.proposed_by_id, proposed_by_name = excluded.proposed_by_name, proposed_at = excluded.proposed_at, approved_by_id = excluded.approved_by_id, approved_by_name = excluded.approved_by_name, approved_at = excluded.approved_at, published_at = excluded.published_at, created_at = excluded.created_at, rev = excluded.rev, rev_at = excluded.rev_at, rev_by_name = excluded.rev_by_name, rev_by_id = excluded.rev_by_id;

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-8.1', 0, 'ACTIVE', 'CURRENT', 'A licence is issued to a natural person; strictly personal and non-transferable.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-8.1', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-8.1', 'licenceRequired', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-8.1', 'licenceHolder', 1, NULL, NULL, 'natural_person');

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-11.1', 1, 'ACTIVE', 'CURRENT', 'Only a Football Agent may perform Football Agent Services. CJEU: the licence requirement "may be justified".', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-11.1', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-11.1', 1, 'CJEU press release 110/26, judgment C-209/23 RRC Sports', '16 Jul 2026', '2026-07-16', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-11.1', 'onlyLicensedAgentPerforms', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-11.3', 2, 'ACTIVE', 'CURRENT', 'Agency employees who are not Football Agents may not perform services or make any Approach.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-11.3', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-11.3', 'agencyStaffMayNotApproach', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.2', 3, 'ACTIVE', 'CURRENT', 'Only a Football Agent may Approach a potential Client.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.2', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-12.2', 'onlyLicensedAgentApproaches', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.3', 4, 'ACTIVE', 'CURRENT', 'Two-year maximum for agreements with Individuals; automatic renewal void.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.3', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-12.3', 'maxTermMonthsIndividual', 0, NULL, 24, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.4', 5, 'ACTIVE', 'CURRENT', NULL, NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.4', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-12.4', 'oneAgreementPerPair', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-12.4', 'legalAdviceNotice', 1, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.8', 6, 'UNDER_LEGAL_REVIEW', 'UNCERTAIN_OPERATIVE_STATUS', 'Circular 1873 (30 Dec 2023) suspended enforcement "until the European Court of Justice renders a final decision"; the CJEU decided C-209/23 on 16 Jul 2026 and referred proportionality to the national court; FIFA has issued no instrument since. The operative status is not conclusively established (L-1, DR-46). The engine returns MANUAL_REGULATORY_REVIEW_REQUIRED wherever this rule would decide an outcome and no national ACTIVE entry applies.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.8', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.8', 1, 'FIFA Circular no. 1873 — update on implementation', '30 Dec 2023', '2023-12-30', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.8', 2, 'CJEU press release 110/26, judgment C-209/23 RRC Sports', '16 Jul 2026', '2026-07-16', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.8', 3, 'FIFA statement welcoming the CJEU decision', '16 Jul 2026', '2026-07-16', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.8', 4, 'FIFA agents FAQ', 'last updated 23 Jan 2025', '2025-01-23', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_overrides (policy_id, rule_id, ord, jurisdiction, scope, override_rule_id) VALUES ('jp-fifa-2025-1', 'FIFA-12.8', 0, 'ENG', 'national', 'ENG-6.3');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-12.8', 'permittedSets', 0, NULL, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_param_items (policy_id, rule_id, name, set_no, ord, member, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-12.8', 'permittedSets', 0, 0, NULL, NULL, 'individual');

INSERT INTO jurisdiction_policy_rule_param_items (policy_id, rule_id, name, set_no, ord, member, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-12.8', 'permittedSets', 0, 1, NULL, NULL, 'engaging_entity');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-12.8', 'consentKind', 1, NULL, NULL, 'dual_representation');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-12.8', 'consentInAdvance', 2, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.9', 7, 'UNDER_LEGAL_REVIEW', 'UNCERTAIN_OPERATIVE_STATUS', 'Circular 1873 (30 Dec 2023) suspended enforcement "until the European Court of Justice renders a final decision"; the CJEU decided C-209/23 on 16 Jul 2026 and referred proportionality to the national court; FIFA has issued no instrument since. The operative status is not conclusively established (L-1, DR-46). The engine returns MANUAL_REGULATORY_REVIEW_REQUIRED wherever this rule would decide an outcome and no national ACTIVE entry applies.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.9', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.9', 1, 'FIFA Circular no. 1873 — update on implementation', '30 Dec 2023', '2023-12-30', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.9', 2, 'CJEU press release 110/26, judgment C-209/23 RRC Sports', '16 Jul 2026', '2026-07-16', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.9', 3, 'FIFA statement welcoming the CJEU decision', '16 Jul 2026', '2026-07-16', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.9', 4, 'FIFA agents FAQ', 'last updated 23 Jan 2025', '2025-01-23', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_overrides (policy_id, rule_id, ord, jurisdiction, scope, override_rule_id) VALUES ('jp-fifa-2025-1', 'FIFA-12.9', 0, 'ENG', 'national', 'ENG-6.4');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-12.9', 'prohibitedWith', 0, NULL, NULL, 'releasing_entity');

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.10', 8, 'UNDER_LEGAL_REVIEW', 'UNCERTAIN_OPERATIVE_STATUS', 'Circular 1873 (30 Dec 2023) suspended enforcement "until the European Court of Justice renders a final decision"; the CJEU decided C-209/23 on 16 Jul 2026 and referred proportionality to the national court; FIFA has issued no instrument since. The operative status is not conclusively established (L-1, DR-46). The engine returns MANUAL_REGULATORY_REVIEW_REQUIRED wherever this rule would decide an outcome and no national ACTIVE entry applies.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.10', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.10', 1, 'FIFA Circular no. 1873 — update on implementation', '30 Dec 2023', '2023-12-30', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.10', 2, 'CJEU press release 110/26, judgment C-209/23 RRC Sports', '16 Jul 2026', '2026-07-16', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-12.10', 3, 'FIFA statement welcoming the CJEU decision', '16 Jul 2026', '2026-07-16', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_overrides (policy_id, rule_id, ord, jurisdiction, scope, override_rule_id) VALUES ('jp-fifa-2025-1', 'FIFA-12.10', 0, 'ENG', 'national', 'ENG-6.5');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-12.10', 'connectedAgentsAreOne', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-12.10', 'sameAgencyConnected', 1, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-13.1', 9, 'ACTIVE', 'CURRENT', 'The first-professional-contract age is the employing country''s law and is NOT encoded for any country (L-6): the parameter is UNKNOWN → INSUFFICIENT_DATA.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-13.1', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-13.1', 'formula', 0, NULL, NULL, 'six_months_before_first_contract_age');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-13.1', 'firstContractAge', 1, NULL, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-13.1', 'guardianConsentBeforeApproach', 2, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-13.2', 10, 'ACTIVE', 'CURRENT', NULL, NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-13.2', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-13.2', 1, 'FIFA agents FAQ', 'last updated 23 Jan 2025', '2025-01-23', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-13.2', 'minorsAccreditationRequired', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-13.2', 'validityYears', 1, NULL, 3, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-14.2', 11, 'UNDER_LEGAL_REVIEW', 'UNCERTAIN_OPERATIVE_STATUS', 'Client-pays and the fee framework; no fee rule is enforced by ScoutBox (P-5).', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-14.2', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-14.2', 1, 'FIFA Circular no. 1873 — update on implementation', '30 Dec 2023', '2023-12-30', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-14.2', 2, 'CJEU press release 110/26, judgment C-209/23 RRC Sports', '16 Jul 2026', '2026-07-16', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-14.2', 'informational', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-14.9', 12, 'ACTIVE', 'CURRENT', NULL, NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-14.9', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-14.9', 'informational', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-14.9', 'noFeeForMinorWithoutProContract', 1, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-15.1', 13, 'UNDER_LEGAL_REVIEW', 'UNCERTAIN_OPERATIVE_STATUS', 'Fee caps. Never validated (DR-31).', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-15.1', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-15.1', 1, 'FIFA Circular no. 1873 — update on implementation', '30 Dec 2023', '2023-12-30', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-15.1', 2, 'CJEU press release 110/26, judgment C-209/23 RRC Sports', '16 Jul 2026', '2026-07-16', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-15.1', 'informational', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-15.3', 14, 'UNDER_LEGAL_REVIEW', 'UNCERTAIN_OPERATIVE_STATUS', 'Other Services presumption: review, never prohibit (DR-34).', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-15.3', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-15.3', 1, 'FIFA Circular no. 1873 — update on implementation', '30 Dec 2023', '2023-12-30', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-15.3', 'otherServicesPresumptionMonths', 0, NULL, 24, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-16.1b', 15, 'UNDER_LEGAL_REVIEW', 'UNCERTAIN_OPERATIVE_STATUS', 'CJEU: the exclusive-agreement approach window "appears … incompatible with the prohibition on cartels". Manual review, never a hard block (DR-33).', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-16.1b', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-16.1b', 1, 'CJEU press release 110/26, judgment C-209/23 RRC Sports', '16 Jul 2026', '2026-07-16', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-16.1b', 'exclusivityWindowMonths', 0, NULL, 2, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-16.2c', 16, 'ACTIVE', 'CURRENT', NULL, NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-16.2c', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-16.2c', 'informational', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-16.2c', 'discloseConflicts', 1, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-19', 17, 'SUSPENDED', 'CURRENT_BUT_SUSPENDED', 'Publication suspended by Circular 1873 and constrained by the GDPR per the CJEU; ScoutBox publishes nothing.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-19', 0, 'FIFA Football Agent Regulations (FFAR)', 'edition approved 10 Dec 2024', '2025-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-19', 1, 'FIFA Circular no. 1873 — update on implementation', '30 Dec 2023', '2023-12-30', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-19', 2, 'CJEU press release 110/26, judgment C-209/23 RRC Sports', '16 Jul 2026', '2026-07-16', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-19', 'informational', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-fifa-2025-1', 'FIFA-RSTP-2027', 18, 'PENDING_IMPLEMENTATION', 'ANNOUNCED', 'Announced regulatory framework in force 1 Jan 2027; no agent-regulation content published. Never applied before its effective date.', '2027-01-01');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-fifa-2025-1', 'FIFA-RSTP-2027', 0, 'FIFA Bureau of the Council — new regulatory framework for the transfer system', '10 Jun 2026', '2027-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-fifa-2025-1', 'FIFA-RSTP-2027', 'effectiveFrom', 0, NULL, NULL, '2027-01-01');

INSERT INTO jurisdiction_policy_publishers (policy_id, ord, by_kind, by_id, by_name) VALUES ('jp-fifa-2025-1', 0, 'system', 'migration-2306', 'seeded from the regulatory snapshot (18 Sep 2026)');

INSERT INTO jurisdiction_policy_history (id, policy_id, ord, at, by_kind, by_id, by_name, by_role, action, detail_seeded) VALUES ('aud-mig0027-1', 'jp-fifa-2025-1', 0, (__NOW__ + 0), 'system', NULL, 'migration 0027_compliance_policies', NULL, 'policy_version_published', 1);

INSERT INTO jurisdiction_policies (id, regulator, jurisdiction, policy_version, supersedes_id, effective_from_date, effective_to_date, status, proposed_by_id, proposed_by_name, proposed_at, approved_by_id, approved_by_name, approved_at, published_at, created_at, rev, rev_at, rev_by_name, rev_by_id) VALUES ('jp-eng-2026-27-1', 'FA', 'ENG', 1, NULL, '2026-06-01', NULL, 'published', NULL, NULL, NULL, NULL, NULL, NULL, (__NOW__ + 0), (__NOW__ + 0), 1, (__NOW__ + 0), NULL, NULL) ON CONFLICT(id) DO UPDATE SET regulator = excluded.regulator, jurisdiction = excluded.jurisdiction, policy_version = excluded.policy_version, supersedes_id = excluded.supersedes_id, effective_from_date = excluded.effective_from_date, effective_to_date = excluded.effective_to_date, status = excluded.status, proposed_by_id = excluded.proposed_by_id, proposed_by_name = excluded.proposed_by_name, proposed_at = excluded.proposed_at, approved_by_id = excluded.approved_by_id, approved_by_name = excluded.approved_by_name, approved_at = excluded.approved_at, published_at = excluded.published_at, created_at = excluded.created_at, rev = excluded.rev, rev_at = excluded.rev_at, rev_by_name = excluded.rev_by_name, rev_by_id = excluded.rev_by_id;

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-2.1', 0, 'ACTIVE', 'CURRENT', 'Before any regulated conduct an agent must be an FA Registered Football Agent; registration requires a FIFA licence.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-2.1', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-2.1', 1, 'The FA Football Agent Regulations Guidance 2026-27', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-2.1', 'nationalRegistrationRequired', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-2.1', 'requiresFifaLicence', 1, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-2.10', 1, 'ACTIVE', 'CURRENT', 'FIFA licence suspended or withdrawn → FA registration automatically suspended or withdrawn.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-2.10', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-2.10', 'cascadeFromFifaLicence', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-3.1', 2, 'ACTIVE', 'CURRENT', NULL, NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-3.1', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-3.1', 'onlyRegisteredAgentPerforms', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-3.3', 3, 'ACTIVE', 'CURRENT', NULL, NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-3.3', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-3.3', 1, 'The FA Football Agent Regulations Guidance 2026-27', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-3.3', 'agencyStaffMayNotApproach', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-4.1b', 4, 'ACTIVE', 'CURRENT', 'A licensed, FA-registered colleague may perform under an agency-party agreement with all parties'' written consent. Modelled; DISABLED in production until L-9 (DR-45).', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-4.1b', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-4.1b', 1, 'The FA Football Agent Regulations Guidance 2026-27', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-4.1b', 'agencyPartyColleaguePerformance', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-4.1b', 'consentKind', 1, NULL, NULL, 'agency_performance');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-4.1b', 'productionEnabled', 2, 0, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-4.1b', 'pendingLegalReview', 3, NULL, NULL, 'L-9');

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-4.3', 5, 'ACTIVE', 'CURRENT', NULL, NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-4.3', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-4.3', 'maxTermMonthsIndividual', 0, NULL, 24, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-4.4', 6, 'ACTIVE', 'CURRENT', NULL, NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-4.4', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-4.4', 'oneAgreementPerPair', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-4.5', 7, 'ACTIVE', 'CURRENT', NULL, NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-4.5', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-4.5', 1, 'The FA Football Agent Regulations Guidance 2026-27', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-4.5', 'legalAdviceNotice', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-4.5', 'pfaLmaNotice', 1, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-5.1', 8, 'ACTIVE', 'CURRENT', 'Not before 1 September in the Academic Year in which the Minor reaches 16; prior written guardian consent before any Approach or agreement. England''s formula only; never generalised (DR-48).', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-5.1', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-5.1', 1, 'The FA Football Agent Regulations Guidance 2026-27', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-5.1', 'formula', 0, NULL, NULL, 'academic_year_16');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-5.1', 'academicYearStart', 1, NULL, NULL, '09-01');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-5.1', 'guardianConsentBeforeApproach', 2, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-5.1', 'coversIndirectApproach', 3, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-5.2', 9, 'ACTIVE', 'CURRENT', 'Additional authorisation to deal with Minors from The FA; suitability incl. enhanced DBS; valid three years; automatic suspension on lapse.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-5.2', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-5.2', 1, 'The FA Football Agent Regulations Guidance 2026-27', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-5.2', 2, 'The FA — FA Registered Football Agent criminal record check process', 'undated, current', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-5.2', 'minorsAuthorisationRequired', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-5.2', 'validityYears', 1, NULL, 3, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-5.2', 'enhancedDbsWithinMonths', 2, NULL, 3, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-6.3', 10, 'ACTIVE', 'CURRENT', 'Permitted dual OR multiple representation with four safeguards (all parties'' prior written consent; full particulars incl. fees; opportunity for independent legal advice; express written consent on the proposed terms).', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-6.3', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-6.3', 1, 'The FA Football Agent Regulations Guidance 2026-27', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-6.3', 'permittedMultiple', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-6.3', 'excludedRole', 1, NULL, NULL, 'releasing_entity');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-6.3', 'consentKind', 2, NULL, NULL, 'dual_representation');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-6.3', 'consentInAdvance', 3, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-6.3', 'fullParticularsRequired', 4, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-6.3', 'legalAdviceOfferRequired', 5, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-6.3', 'prescribedForm', 6, NULL, NULL, 'AF1 at completion constitutes written consent');

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-6.4', 11, 'ACTIVE', 'CURRENT', 'When acting for a Releasing Club the agent may perform services for no other party in the same National Transaction.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-6.4', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-6.4', 1, 'The FA Football Agent Regulations Guidance 2026-27', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-6.4', 'prohibitedWith', 0, NULL, NULL, 'releasing_entity');

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-6.5', 12, 'ACTIVE', 'CURRENT', 'An agent and a Connected Football Agent may not act for different parties in the same National Transaction except under 6.3.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-6.5', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-6.5', 1, 'The FA Football Agent Regulations Guidance 2026-27', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-6.5', 'connectedAgentsAreOne', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-6.5', 'sameAgencyConnected', 1, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-7.2', 13, 'ACTIVE', 'CURRENT', 'Client pays (with the USD 200,000 engaging-club exception, 7.3). Recorded, never enforced (DR-31).', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-7.2', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-7.2', 1, 'The FA Football Agent Regulations Guidance 2026-27', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-7.2', 'informational', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-7.10', 14, 'ACTIVE', 'CURRENT', NULL, NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-7.10', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-7.10', 1, 'The FA Football Agent Regulations Guidance 2026-27', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-7.10', 'informational', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-7.10', 'noFeeForMinorWithoutProContract', 1, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-7.13', 15, 'PARTIALLY_SUSPENDED', 'CURRENT_WITH_PARTIAL_SUSPENSION', 'Clearing House: not covered by the 2026-27 Guidance, likely shaded (L-7). No payment channel exists.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-7.13', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-7.13', 'informational', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-7.13', 'activeLimbs', 1, NULL, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-8.1b', 16, 'UNDER_LEGAL_REVIEW', 'UNCERTAIN_OPERATIVE_STATUS', 'Exclusive-agreement approach window: in the 2026-27 text; doubtful after the CJEU judgment (L-2). Manual review, never a hard block.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-8.1b', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-8.1b', 1, 'CJEU press release 110/26, judgment C-209/23 RRC Sports', '16 Jul 2026', '2026-07-16', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-8.1b', 'exclusivityWindowMonths', 0, NULL, 2, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-eng-2026-27-1', 'ENG-8.3g', 17, 'ACTIVE', 'CURRENT', 'Lodging duties. ScoutBox keeps records; it does not file (L-16).', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-8.3g', 0, 'The FA Football Agent Regulations 2026-27 (Handbook, Rules of The Association s.17)', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-eng-2026-27-1', 'ENG-8.3g', 1, 'The FA Football Agent Regulations Guidance 2026-27', '2026-27', '2026-06-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-8.3g', 'informational', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-eng-2026-27-1', 'ENG-8.3g', 'lodgeWithinDays', 1, NULL, 14, NULL);

INSERT INTO jurisdiction_policy_publishers (policy_id, ord, by_kind, by_id, by_name) VALUES ('jp-eng-2026-27-1', 0, 'system', 'migration-2306', 'seeded from the regulatory snapshot (18 Sep 2026)');

INSERT INTO jurisdiction_policy_history (id, policy_id, ord, at, by_kind, by_id, by_name, by_role, action, detail_seeded) VALUES ('aud-mig0027-2', 'jp-eng-2026-27-1', 0, (__NOW__ + 0), 'system', NULL, 'migration 0027_compliance_policies', NULL, 'policy_version_published', 1);

INSERT INTO jurisdiction_policies (id, regulator, jurisdiction, policy_version, supersedes_id, effective_from_date, effective_to_date, status, proposed_by_id, proposed_by_name, proposed_at, approved_by_id, approved_by_name, approved_at, published_at, created_at, rev, rev_at, rev_by_name, rev_by_id) VALUES ('jp-usa-2024-1', 'USSF', 'USA', 1, NULL, '2024-01-01', NULL, 'published', NULL, NULL, NULL, NULL, NULL, NULL, (__NOW__ + 0), (__NOW__ + 0), 1, (__NOW__ + 0), NULL, NULL) ON CONFLICT(id) DO UPDATE SET regulator = excluded.regulator, jurisdiction = excluded.jurisdiction, policy_version = excluded.policy_version, supersedes_id = excluded.supersedes_id, effective_from_date = excluded.effective_from_date, effective_to_date = excluded.effective_to_date, status = excluded.status, proposed_by_id = excluded.proposed_by_id, proposed_by_name = excluded.proposed_by_name, proposed_at = excluded.proposed_at, approved_by_id = excluded.approved_by_id, approved_by_name = excluded.approved_by_name, approved_at = excluded.approved_at, published_at = excluded.published_at, created_at = excluded.created_at, rev = excluded.rev, rev_at = excluded.rev_at, rev_by_name = excluded.rev_by_name, rev_by_id = excluded.rev_by_id;

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-usa-2024-1', 'USA-LIC', 0, 'ACTIVE', 'CURRENT', 'Effective 1 Jan 2024 U.S. Soccer enforces the FFAR; any agent in its jurisdiction must be FIFA-licensed.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-usa-2024-1', 'USA-LIC', 0, 'U.S. Soccer — Player Agents', 'read 18 Sep 2026', '2024-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-usa-2024-1', 'USA-LIC', 'licenceRequired', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-usa-2024-1', 'USA-BGC', 1, 'ACTIVE', 'CURRENT', 'Background check and SafeSport training required for all agents operating in the United States; scope is a counsel item (R-U2).', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-usa-2024-1', 'USA-BGC', 0, 'U.S. Soccer — Player Agents', 'read 18 Sep 2026', '2024-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-usa-2024-1', 'USA-BGC', 'domesticAuthorisationRequired', 0, 1, NULL, NULL);

INSERT INTO jurisdiction_policy_rule_params (policy_id, rule_id, name, ord, flag_value, count_value, text_value) VALUES ('jp-usa-2024-1', 'USA-BGC', 'kind', 1, NULL, NULL, 'background_check_safesport');

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-usa-2024-1', 'USA-MULTI', 2, 'UNKNOWN', 'UNCERTAIN_OPERATIVE_STATUS', 'No U.S. Soccer national regulations text was located; multiple-representation rules are not encoded.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-usa-2024-1', 'USA-MULTI', 0, 'U.S. Soccer — Player Agents', 'read 18 Sep 2026', '2024-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_rules (policy_id, rule_id, ord, rule_status, text_status, note, effective_from_date) VALUES ('jp-usa-2024-1', 'USA-MINOR', 3, 'UNKNOWN', 'UNCERTAIN_OPERATIVE_STATUS', 'No minors approach timing or first-contract age was located (L-8). Any U.S. minors pathway is INSUFFICIENT_DATA → refused.', NULL);

INSERT INTO jurisdiction_policy_rule_sources (policy_id, rule_id, ord, source, version, effective_date, retrieved_date) VALUES ('jp-usa-2024-1', 'USA-MINOR', 0, 'U.S. Soccer — Player Agents', 'read 18 Sep 2026', '2024-01-01', '2026-09-18');

INSERT INTO jurisdiction_policy_publishers (policy_id, ord, by_kind, by_id, by_name) VALUES ('jp-usa-2024-1', 0, 'system', 'migration-2306', 'seeded from the regulatory snapshot (18 Sep 2026)');

INSERT INTO jurisdiction_policy_history (id, policy_id, ord, at, by_kind, by_id, by_name, by_role, action, detail_seeded) VALUES ('aud-mig0027-3', 'jp-usa-2024-1', 0, (__NOW__ + 0), 'system', NULL, 'migration 0027_compliance_policies', NULL, 'policy_version_published', 1);
