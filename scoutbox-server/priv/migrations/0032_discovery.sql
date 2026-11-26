-- 0032_discovery: Recruitment Briefs, Nobody Missed reviews, Second Look items and Dynamic Watchlists with their membership history become typed tables

CREATE TABLE recruitment_briefs (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  title                                    TEXT NOT NULL CHECK (length(title) <= 120 AND length(title) > 0),
  version                                  INTEGER NOT NULL,
  status                                   TEXT NOT NULL CHECK (status IN ('draft','active','paused','closed','archived')),
  active_from_date                         TEXT CHECK (active_from_date IS NULL OR length(active_from_date) <= 10),
  active_until_date                        TEXT CHECK (active_until_date IS NULL OR length(active_until_date) <= 10),
  role_id                                  TEXT CHECK (role_id IS NULL OR length(role_id) <= 64 AND length(role_id) > 0),
  vacancy_id                               TEXT CHECK (vacancy_id IS NULL OR length(vacancy_id) <= 64 AND length(vacancy_id) > 0),
  created_by_user_id                       TEXT NOT NULL CHECK (length(created_by_user_id) <= 80 AND length(created_by_user_id) > 0),
  created_by_name                          TEXT CHECK (created_by_name IS NULL OR length(created_by_name) <= 200),
  created_at                               INTEGER NOT NULL,
  updated_at                               INTEGER NOT NULL,
  rev                                      INTEGER NOT NULL,
  rev_at                                   INTEGER,
  rev_by_user_id                           TEXT CHECK (rev_by_user_id IS NULL OR length(rev_by_user_id) <= 80 AND length(rev_by_user_id) > 0),
  rev_by_name                              TEXT CHECK (rev_by_name IS NULL OR length(rev_by_name) <= 200),
  min_age                                  INTEGER,
  max_age                                  INTEGER,
  radius_km                                REAL,
  max_level                                TEXT CHECK (max_level IS NULL OR max_level IN ('amateur','semi_pro','pro')),
  foot                                     TEXT CHECK (foot IS NULL OR foot IN ('Left','Right','Both')),
  availability                             TEXT CHECK (availability IS NULL OR length(availability) <= 40),
  min_trust_band                           TEXT CHECK (min_trust_band IS NULL OR min_trust_band IN ('limited_evidence','developing_evidence','established_evidence','strong_evidence','very_strong_evidence')),
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK (active_from_date IS NULL OR active_from_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  CHECK (active_until_date IS NULL OR active_until_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  CHECK (version >= 1),
  CHECK (rev >= 1),
  CHECK (min_age IS NULL OR (min_age >= 5 AND min_age <= 60)),
  CHECK (max_age IS NULL OR (max_age >= 5 AND max_age <= 60)),
  CHECK (min_age IS NULL OR max_age IS NULL OR min_age <= max_age),
  CHECK (radius_km IS NULL OR (radius_km > 0 AND radius_km <= 20000)),
  CHECK (active_from_date IS NULL OR active_until_date IS NULL OR active_from_date <= active_until_date)
) STRICT;
CREATE INDEX recruitment_briefs_org_updated ON recruitment_briefs (org_id, updated_at);
CREATE TABLE recruitment_brief_values (
  brief_id                                 TEXT NOT NULL CHECK (length(brief_id) > 0 AND length(brief_id) <= 80),
  kind                                     TEXT NOT NULL CHECK (kind IN ('position','evidence_requirement','combine_protocol')),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  value                                    TEXT NOT NULL CHECK (length(value) > 0 AND length(value) <= 80),
  CHECK (kind <> 'position' OR value IN ('GK','CB','RB','LB','RWB','LWB','CDM','CM','CAM','RW','LW','ST','CF')),
  CHECK (kind <> 'evidence_requirement' OR value IN ('recent_full_match','coach_reference','confirmed_current_club','combine_verified')),
  FOREIGN KEY (brief_id) REFERENCES recruitment_briefs(id) ON DELETE CASCADE,
  PRIMARY KEY (brief_id, kind, ord),
  UNIQUE (brief_id, kind, value)
) STRICT;
CREATE TABLE recruitment_brief_history (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  brief_id                                 TEXT NOT NULL CHECK (length(brief_id) <= 80 AND length(brief_id) > 0),
  at                                       INTEGER NOT NULL,
  by_kind                                  TEXT NOT NULL CHECK (by_kind IN ('org')),
  by_id                                    TEXT NOT NULL CHECK (length(by_id) <= 80 AND length(by_id) > 0),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  action                                   TEXT NOT NULL CHECK (action IN ('recruitment_brief_created','recruitment_brief_activated','recruitment_brief_updated')),
  detail_version                           INTEGER,
  detail_from                              TEXT CHECK (detail_from IS NULL OR detail_from IN ('draft','active','paused','closed','archived')),
  detail_to                                TEXT CHECK (detail_to IS NULL OR detail_to IN ('draft','active','paused','closed','archived')),
  detail_criteria_changed                  INTEGER CHECK (detail_criteria_changed IS NULL OR detail_criteria_changed IN (0,1)),
  FOREIGN KEY (brief_id) REFERENCES recruitment_briefs(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX recruitment_brief_history_brief ON recruitment_brief_history (brief_id);
CREATE TABLE nobody_missed_reviews (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  brief_id                                 TEXT NOT NULL CHECK (length(brief_id) <= 80 AND length(brief_id) > 0),
  brief_version                            INTEGER NOT NULL,
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  state                                    TEXT NOT NULL CHECK (state IN ('open','reviewed','added_to_room','dismissed')),
  created_at                               INTEGER NOT NULL,
  updated_at                               INTEGER NOT NULL,
  reviewed_by_user_id                      TEXT CHECK (reviewed_by_user_id IS NULL OR length(reviewed_by_user_id) <= 80 AND length(reviewed_by_user_id) > 0),
  reviewed_by_name                         TEXT CHECK (reviewed_by_name IS NULL OR length(reviewed_by_name) <= 200),
  reviewed_at                              INTEGER,
  dismiss_reason                           TEXT CHECK (dismiss_reason IS NULL OR dismiss_reason IN ('already_known','not_current_need','evidence_insufficient','role_mismatch_after_review','timing','other')),
  dismissed_by_user_id                     TEXT CHECK (dismissed_by_user_id IS NULL OR length(dismissed_by_user_id) <= 80 AND length(dismissed_by_user_id) > 0),
  dismissed_by_name                        TEXT CHECK (dismissed_by_name IS NULL OR length(dismissed_by_name) <= 200),
  dismissed_at                             INTEGER,
  room_id                                  TEXT CHECK (room_id IS NULL OR length(room_id) <= 80 AND length(room_id) > 0),
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (brief_id) REFERENCES recruitment_briefs(id) ON DELETE RESTRICT,
  FOREIGN KEY (reviewed_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (dismissed_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (room_id) REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  CHECK (state <> 'dismissed' OR dismissed_at IS NOT NULL),
  CHECK (state <> 'added_to_room' OR room_id IS NOT NULL),
  UNIQUE (org_id, brief_id, player_id)
) STRICT;
CREATE INDEX nobody_missed_reviews_brief ON nobody_missed_reviews (brief_id);
CREATE TABLE nobody_missed_review_history (
  review_id                                TEXT NOT NULL CHECK (length(review_id) <= 80 AND length(review_id) > 0),
  ord                                      INTEGER NOT NULL,
  at                                       INTEGER NOT NULL,
  state                                    TEXT NOT NULL CHECK (state IN ('open','reviewed','added_to_room','dismissed')),
  by_user_id                               TEXT NOT NULL CHECK (length(by_user_id) <= 80 AND length(by_user_id) > 0),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  FOREIGN KEY (review_id) REFERENCES nobody_missed_reviews(id) ON DELETE CASCADE,
  FOREIGN KEY (by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  PRIMARY KEY (review_id, ord),
  CHECK (ord >= 0)
) STRICT;
CREATE TABLE second_look_items (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  room_id                                  TEXT NOT NULL CHECK (length(room_id) <= 80 AND length(room_id) > 0),
  decision_id                              TEXT NOT NULL CHECK (length(decision_id) <= 80 AND length(decision_id) > 0),
  policy_version                           INTEGER NOT NULL,
  trigger_type                             TEXT NOT NULL CHECK (trigger_type IN ('direct_reason_resolved','significant_new_evidence','evidence_removed','general_update')),
  status                                   TEXT NOT NULL CHECK (status IN ('open','reviewed','dismissed','reopened_room','expired')),
  created_at                               INTEGER NOT NULL,
  updated_at                               INTEGER NOT NULL,
  latest_change_at                         INTEGER NOT NULL,
  reviewed_at                              INTEGER,
  reviewed_by_user_id                      TEXT CHECK (reviewed_by_user_id IS NULL OR length(reviewed_by_user_id) <= 80 AND length(reviewed_by_user_id) > 0),
  reviewed_by_name                         TEXT CHECK (reviewed_by_name IS NULL OR length(reviewed_by_name) <= 200),
  dismissed_at                             INTEGER,
  dismissed_by_user_id                     TEXT CHECK (dismissed_by_user_id IS NULL OR length(dismissed_by_user_id) <= 80 AND length(dismissed_by_user_id) > 0),
  dismissed_by_name                        TEXT CHECK (dismissed_by_name IS NULL OR length(dismissed_by_name) <= 200),
  dismiss_reason                           TEXT CHECK (dismiss_reason IS NULL OR dismiss_reason IN ('already_reviewed_elsewhere','change_not_material','timing_not_right','squad_need_changed','no_action_required','other')),
  reopened_at                              INTEGER,
  reopened_by_user_id                      TEXT CHECK (reopened_by_user_id IS NULL OR length(reopened_by_user_id) <= 80 AND length(reopened_by_user_id) > 0),
  reopened_by_name                         TEXT CHECK (reopened_by_name IS NULL OR length(reopened_by_name) <= 200),
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (room_id) REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  FOREIGN KEY (decision_id) REFERENCES room_decisions(id) ON DELETE RESTRICT,
  FOREIGN KEY (reviewed_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (dismissed_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (reopened_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK (status <> 'reviewed' OR reviewed_at IS NOT NULL),
  CHECK (status <> 'dismissed' OR dismissed_at IS NOT NULL),
  CHECK (status <> 'reopened_room' OR reopened_at IS NOT NULL),
  UNIQUE (org_id, room_id, decision_id)
) STRICT;
CREATE INDEX second_look_items_org_player ON second_look_items (org_id, player_id);
CREATE TABLE second_look_item_fingerprints (
  item_id                                  TEXT NOT NULL CHECK (length(item_id) > 0 AND length(item_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  fingerprint                              TEXT NOT NULL CHECK (length(fingerprint) > 0 AND length(fingerprint) <= 400),
  FOREIGN KEY (item_id) REFERENCES second_look_items(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, ord),
  UNIQUE (item_id, fingerprint)
) STRICT;
CREATE TABLE second_look_item_reasons (
  item_id                                  TEXT NOT NULL CHECK (length(item_id) > 0 AND length(item_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  code                                     TEXT NOT NULL CHECK (code IN ('insufficient_recent_evidence','insufficient_full_match','reference_missing','combine_missing','trial_needed','continue_monitoring','physical_profile','technical_fit','tactical_fit','development_upside','not_current_priority','position_need','trial_outcome','squad_space','budget','timing','registration','travel_logistics','eligibility','player_unavailable')),
  FOREIGN KEY (item_id) REFERENCES second_look_items(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, ord),
  UNIQUE (item_id, code)
) STRICT;
CREATE TABLE second_look_item_history (
  item_id                                  TEXT NOT NULL CHECK (length(item_id) > 0 AND length(item_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  at                                       INTEGER NOT NULL,
  action                                   TEXT NOT NULL CHECK (action IN ('surfaced','resurfaced','reviewed','dismissed','reopened_room')),
  by_user_id                               TEXT CHECK (by_user_id IS NULL OR (length(by_user_id) > 0 AND length(by_user_id) <= 80)),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  reason                                   TEXT CHECK (reason IS NULL OR reason IN ('materially_new_evidence','already_reviewed_elsewhere','change_not_material','timing_not_right','squad_need_changed','no_action_required','other')),
  FOREIGN KEY (item_id) REFERENCES second_look_items(id) ON DELETE CASCADE,
  FOREIGN KEY (by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  PRIMARY KEY (item_id, ord),
  CHECK ((action IN ('surfaced','resurfaced')) = (by_user_id IS NULL)),
  CHECK (by_user_id IS NOT NULL OR by_name IS NULL),
  CHECK (action IN ('resurfaced','dismissed') OR reason IS NULL),
  CHECK (action <> 'resurfaced' OR reason IS NOT NULL)
) STRICT;
CREATE TABLE dynamic_watchlists (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  name                                     TEXT NOT NULL CHECK (length(name) <= 80 AND length(name) > 0),
  mode                                     TEXT NOT NULL CHECK (mode IN ('live_linked','snapshot')),
  status                                   TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
  source_type                              TEXT NOT NULL CHECK (source_type IN ('brief','saved_search','criteria')),
  brief_id                                 TEXT CHECK (brief_id IS NULL OR length(brief_id) <= 80 AND length(brief_id) > 0),
  source_ref                               TEXT CHECK (source_ref IS NULL OR length(source_ref) <= 64 AND length(source_ref) > 0),
  schema_version                           INTEGER NOT NULL,
  criteria_version                         TEXT NOT NULL CHECK (length(criteria_version) <= 40 AND length(criteria_version) > 0),
  notify                                   INTEGER NOT NULL CHECK (notify IN (0,1)),
  created_by_user_id                       TEXT NOT NULL CHECK (length(created_by_user_id) <= 80 AND length(created_by_user_id) > 0),
  created_by_name                          TEXT CHECK (created_by_name IS NULL OR length(created_by_name) <= 200),
  created_at                               INTEGER NOT NULL,
  updated_at                               INTEGER NOT NULL,
  rev                                      INTEGER NOT NULL,
  rev_at                                   INTEGER,
  rev_by_user_id                           TEXT CHECK (rev_by_user_id IS NULL OR length(rev_by_user_id) <= 80 AND length(rev_by_user_id) > 0),
  rev_by_name                              TEXT CHECK (rev_by_name IS NULL OR length(rev_by_name) <= 200),
  last_criteria_version                    TEXT CHECK (last_criteria_version IS NULL OR length(last_criteria_version) <= 40 AND length(last_criteria_version) > 0),
  last_brief_version                       INTEGER,
  last_reconciled_at                       INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (brief_id) REFERENCES recruitment_briefs(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK ((source_type = 'brief') = (brief_id IS NOT NULL)),
  CHECK (source_type <> 'brief' OR source_ref IS NULL),
  CHECK (mode <> 'live_linked' OR source_type = 'brief'),
  CHECK (rev >= 1),
  CHECK ((last_reconciled_at IS NULL) = (last_criteria_version IS NULL))
) STRICT;
CREATE INDEX dynamic_watchlists_org_updated ON dynamic_watchlists (org_id, updated_at);
CREATE TABLE watchlist_criteria (
  watchlist_id                             TEXT NOT NULL CHECK (length(watchlist_id) > 0 AND length(watchlist_id) <= 80),
  class                                    TEXT NOT NULL CHECK (class IN ('required','preferred')),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  criterion_id                             TEXT NOT NULL CHECK (length(criterion_id) > 0 AND length(criterion_id) <= 600),
  type                                     TEXT NOT NULL CHECK (type IN ('position','age','geography','level','foot','availability','evidence','evidence_recency','trust_band','combine_result','combine_measurement')),
  operator                                 TEXT NOT NULL CHECK (operator IN ('in','between','gte','lte','within_radius','equals','exists','within_days')),
  value_text                               TEXT CHECK (value_text IS NULL OR (length(value_text) > 0 AND length(value_text) <= 80)),
  value_num                                REAL,
  range_min                                INTEGER,
  range_max                                INTEGER,
  primary_only                             INTEGER CHECK (primary_only IS NULL OR primary_only IN (0,1)),
  evidence_kind                            TEXT CHECK (evidence_kind IS NULL OR evidence_kind IN ('any','footage')),
  protocol                                 TEXT CHECK (protocol IS NULL OR (length(protocol) > 0 AND length(protocol) <= 80)),
  FOREIGN KEY (watchlist_id) REFERENCES dynamic_watchlists(id) ON DELETE CASCADE,
  PRIMARY KEY (watchlist_id, class, ord),
  UNIQUE (watchlist_id, class, criterion_id),
  CHECK ((range_min IS NULL) = (range_max IS NULL))
) STRICT;
CREATE TABLE watchlist_criterion_values (
  watchlist_id                             TEXT NOT NULL CHECK (length(watchlist_id) > 0 AND length(watchlist_id) <= 80),
  class                                    TEXT NOT NULL CHECK (class IN ('required','preferred')),
  criterion_ord                            INTEGER NOT NULL CHECK (criterion_ord >= 0),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  value                                    TEXT NOT NULL CHECK (length(value) > 0 AND length(value) <= 80),
  FOREIGN KEY (watchlist_id, class, criterion_ord) REFERENCES watchlist_criteria(watchlist_id, class, ord) ON DELETE CASCADE,
  PRIMARY KEY (watchlist_id, class, criterion_ord, ord)
) STRICT;
CREATE TABLE watchlist_members (
  watchlist_id                             TEXT NOT NULL CHECK (length(watchlist_id) > 0 AND length(watchlist_id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) > 0 AND length(player_id) <= 80),
  FOREIGN KEY (watchlist_id) REFERENCES dynamic_watchlists(id) ON DELETE CASCADE,
  PRIMARY KEY (watchlist_id, player_id)
) STRICT;
CREATE TABLE watchlist_member_checks (
  watchlist_id                             TEXT NOT NULL CHECK (length(watchlist_id) > 0 AND length(watchlist_id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) > 0 AND length(player_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  criterion_id                             TEXT NOT NULL CHECK (length(criterion_id) > 0 AND length(criterion_id) <= 600),
  met                                      INTEGER NOT NULL CHECK (met IN (0,1)),
  FOREIGN KEY (watchlist_id, player_id) REFERENCES watchlist_members(watchlist_id, player_id) ON DELETE CASCADE,
  PRIMARY KEY (watchlist_id, player_id, ord)
) STRICT;
CREATE TABLE watchlist_history (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  watchlist_id                             TEXT NOT NULL CHECK (length(watchlist_id) <= 80 AND length(watchlist_id) > 0),
  at                                       INTEGER NOT NULL,
  by_kind                                  TEXT NOT NULL CHECK (by_kind IN ('org')),
  by_id                                    TEXT NOT NULL CHECK (length(by_id) <= 80 AND length(by_id) > 0),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  action                                   TEXT NOT NULL CHECK (action IN ('watchlist_created','watchlist_updated','watchlist_archived')),
  detail_mode                              TEXT CHECK (detail_mode IS NULL OR detail_mode IN ('live_linked','snapshot')),
  detail_source_type                       TEXT CHECK (detail_source_type IS NULL OR detail_source_type IN ('brief','saved_search','criteria')),
  detail_status                            TEXT CHECK (detail_status IS NULL OR detail_status IN ('active','paused','archived')),
  detail_changed_name                      INTEGER CHECK (detail_changed_name IS NULL OR detail_changed_name IN (0,1)),
  detail_changed_mode                      INTEGER CHECK (detail_changed_mode IS NULL OR detail_changed_mode IN (0,1)),
  detail_changed_status                    INTEGER CHECK (detail_changed_status IS NULL OR detail_changed_status IN (0,1)),
  detail_changed_criteria                  INTEGER CHECK (detail_changed_criteria IS NULL OR detail_changed_criteria IN (0,1)),
  FOREIGN KEY (watchlist_id) REFERENCES dynamic_watchlists(id) ON DELETE CASCADE,
  CHECK ((detail_changed_name IS NULL AND detail_changed_mode IS NULL AND detail_changed_status IS NULL AND detail_changed_criteria IS NULL) OR (detail_changed_name IS NOT NULL AND detail_changed_mode IS NOT NULL AND detail_changed_status IS NOT NULL AND detail_changed_criteria IS NOT NULL))
) STRICT;
CREATE INDEX watchlist_history_watchlist ON watchlist_history (watchlist_id);
CREATE TABLE watchlist_membership_events (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  watchlist_id                             TEXT NOT NULL CHECK (length(watchlist_id) <= 80 AND length(watchlist_id) > 0),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  transition                               TEXT NOT NULL CHECK (transition IN ('entered','left')),
  reason                                   TEXT NOT NULL CHECK (reason IN ('criterion_now_met','criteria_changed','brief_changed','newly_visible','first_evaluation','criterion_no_longer_met','unavailable')),
  criterion_id                             TEXT CHECK (criterion_id IS NULL OR length(criterion_id) <= 600 AND length(criterion_id) > 0),
  text                                     TEXT NOT NULL CHECK (length(text) <= 2000 AND length(text) > 0),
  criteria_version                         TEXT NOT NULL CHECK (length(criteria_version) <= 40 AND length(criteria_version) > 0),
  brief_version                            INTEGER,
  policy_version                           INTEGER NOT NULL,
  at                                       INTEGER NOT NULL,
  fingerprint                              TEXT NOT NULL CHECK (length(fingerprint) <= 400 AND length(fingerprint) > 0),
  FOREIGN KEY (watchlist_id) REFERENCES dynamic_watchlists(id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  UNIQUE (fingerprint)
) STRICT;
CREATE INDEX watchlist_membership_events_watchlist_at ON watchlist_membership_events (watchlist_id, at, id);
CREATE INDEX watchlist_membership_events_org_at ON watchlist_membership_events (org_id, at);
