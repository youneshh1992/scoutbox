-- 0013_safety_audit: the eight audit collections become typed tables (blocks, reports, moderation_log with moderation_flags, org_notes, ledger with ledger_protocols, ops_events, source_changes, idv_queue; vocabulary CHECKs, details as typed columns by type; organisations and staff RESTRICT keys, player references tolerant (Q4), the IDV guardian checked in code (Q4b))

CREATE TABLE blocks (
  seq                              INTEGER PRIMARY KEY,
  id                               TEXT NOT NULL UNIQUE CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                        TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  org_id                           TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  by_kind                          TEXT NOT NULL CHECK (by_kind IN ('player','guardian')),
  reason                           TEXT NOT NULL CHECK (length(reason) <= 2000),
  created_at                       INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX blocks_player_id_org_id ON blocks (player_id, org_id);
CREATE INDEX blocks_org_id ON blocks (org_id);
CREATE TABLE reports (
  seq                              INTEGER PRIMARY KEY,
  id                               TEXT NOT NULL UNIQUE CHECK (length(id) > 0 AND length(id) <= 80),
  created_at                       INTEGER NOT NULL,
  by_kind                          TEXT NOT NULL CHECK (by_kind IN ('player','guardian','org_user','system')),
  by_id                            TEXT NOT NULL CHECK (length(by_id) <= 80 AND length(by_id) > 0),
  by_org_id                        TEXT CHECK (by_org_id IS NULL OR length(by_org_id) <= 80 AND length(by_org_id) > 0),
  target_kind                      TEXT NOT NULL CHECK (target_kind IN ('club','scout','player')),
  target_org_id                    TEXT CHECK (target_org_id IS NULL OR length(target_org_id) <= 80 AND length(target_org_id) > 0),
  target_scout_name                TEXT CHECK (target_scout_name IS NULL OR length(target_scout_name) <= 200 AND length(target_scout_name) > 0),
  target_player_id                 TEXT CHECK (target_player_id IS NULL OR length(target_player_id) <= 200 AND length(target_player_id) > 0),
  reason                           TEXT NOT NULL CHECK (length(reason) <= 2000 AND length(reason) > 0),
  urgent                           INTEGER NOT NULL CHECK (urgent IN (0,1)),
  status                           TEXT NOT NULL CHECK (status IN ('pending_review','resolved')),
  outcome                          TEXT CHECK (outcome IS NULL OR length(outcome) <= 2000 AND length(outcome) > 0),
  resolved_at                      INTEGER,
  FOREIGN KEY (by_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (target_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CHECK (status = 'resolved' OR outcome IS NULL),
  CHECK ((by_kind = 'org_user') = (by_org_id IS NOT NULL))
) STRICT;
CREATE INDEX reports_by_kind_by_id ON reports (by_kind, by_id);
CREATE INDEX reports_target_org_id_urgent_status ON reports (target_org_id, urgent, status);
CREATE INDEX reports_status_created_at ON reports (status, created_at);
CREATE INDEX reports_target_player_id ON reports (target_player_id);
CREATE TABLE moderation_log (
  seq                              INTEGER PRIMARY KEY,
  id                               TEXT NOT NULL UNIQUE CHECK (length(id) > 0 AND length(id) <= 80),
  created_at                       INTEGER NOT NULL,
  context_kind                     TEXT NOT NULL CHECK (length(context_kind) <= 60 AND length(context_kind) > 0),
  context_player_id                TEXT CHECK (context_player_id IS NULL OR length(context_player_id) <= 80 AND length(context_player_id) > 0),
  context_org_id                   TEXT CHECK (context_org_id IS NULL OR length(context_org_id) <= 80 AND length(context_org_id) > 0),
  context_user_id                  TEXT CHECK (context_user_id IS NULL OR length(context_user_id) <= 80 AND length(context_user_id) > 0),
  context_channel_id               TEXT CHECK (context_channel_id IS NULL OR length(context_channel_id) <= 80 AND length(context_channel_id) > 0),
  context_request_id               TEXT CHECK (context_request_id IS NULL OR length(context_request_id) <= 80 AND length(context_request_id) > 0),
  context_trial_id                 TEXT CHECK (context_trial_id IS NULL OR length(context_trial_id) <= 80 AND length(context_trial_id) > 0),
  severity                         TEXT NOT NULL CHECK (severity IN ('contact','grooming')),
  excerpt                          TEXT NOT NULL CHECK (length(excerpt) <= 140),
  FOREIGN KEY (context_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (context_user_id) REFERENCES org_users(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX moderation_log_severity ON moderation_log (severity);
CREATE TABLE moderation_flags (
  moderation_id TEXT NOT NULL,
  ord INTEGER NOT NULL CHECK (ord >= 0),
  flag TEXT NOT NULL CHECK (flag IN ('email', 'email_obfuscated', 'phone_number', 'phone_spelled', 'social_handle', 'social_platform', 'url', 'meet_off_platform', 'secrecy', 'personal_probing')),
  PRIMARY KEY (moderation_id, ord),
  FOREIGN KEY (moderation_id) REFERENCES moderation_log(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE org_notes (
  seq                              INTEGER PRIMARY KEY,
  id                               TEXT NOT NULL UNIQUE CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                           TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  player_id                        TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  user_id                          TEXT NOT NULL CHECK (length(user_id) <= 80 AND length(user_id) > 0),
  scout_name                       TEXT NOT NULL CHECK (length(scout_name) <= 200),
  text                             TEXT NOT NULL CHECK (length(text) <= 2000 AND length(text) > 0),
  created_at                       INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES org_users(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX org_notes_org_id_player_id ON org_notes (org_id, player_id);
CREATE TABLE ledger (
  seq                              INTEGER PRIMARY KEY,
  id                               TEXT NOT NULL UNIQUE CHECK (length(id) > 0 AND length(id) <= 80),
  occurred_at                      INTEGER NOT NULL,
  type                             TEXT NOT NULL CHECK (type IN ('view','save','shortlist','contact_request','contact_request_to_guardian','contact_accepted','contact_accepted_by_guardian','contact_declined','contact_declined_by_guardian','trial_request','trial_request_to_guardian','trial_accepted','trial_accepted_by_guardian','trial_declined','trial_declined_by_guardian','message','signing','released_by_club','staff_removed','org_blocked_by_player','org_blocked_by_guardian','account_transitioned','assessment_submitted','attendance_verified','clip_tagged','coach_affiliation_confirmed','level_review','matchday_logged','open_trial_posted','open_trial_registration','open_trial_registration_by_guardian','opportunity_application','passport_view','passport_recruitment_view','passport_share_created','passport_share_revoked','recruitment_room_created','transition_pack_view','trial_checkin','trial_report','box_assignment_created','box_assignment_cancelled','box_challenge_published','box_clip_saved','box_prefs_changed','box_result_invalidated','box_result_restored','combine_attempt_completed','combine_request_created','combine_request_completed','verification_decision','verification_root_approved')),
  player_id                        TEXT CHECK (player_id IS NULL OR length(player_id) <= 80 AND length(player_id) > 0),
  org_id                           TEXT CHECK (org_id IS NULL OR length(org_id) <= 80 AND length(org_id) > 0),
  org_name                         TEXT CHECK (org_name IS NULL OR length(org_name) <= 200),
  user_id                          TEXT CHECK (user_id IS NULL OR length(user_id) <= 80 AND length(user_id) > 0),
  actor_name                       TEXT CHECK (actor_name IS NULL OR length(actor_name) <= 200),
  detail_assignment_id             TEXT CHECK (detail_assignment_id IS NULL OR length(detail_assignment_id) <= 80 AND length(detail_assignment_id) > 0) CHECK (detail_assignment_id IS NULL OR type IN ('box_assignment_cancelled')),
  detail_drill_id                  TEXT CHECK (detail_drill_id IS NULL OR length(detail_drill_id) <= 80 AND length(detail_drill_id) > 0) CHECK (detail_drill_id IS NULL OR type IN ('box_assignment_created', 'box_challenge_published')),
  detail_target_type               TEXT CHECK (detail_target_type IS NULL OR length(detail_target_type) <= 40) CHECK (detail_target_type IS NULL OR type IN ('box_assignment_created')),
  detail_target_value              REAL CHECK (detail_target_value IS NULL OR type IN ('box_assignment_created')),
  detail_challenge_id              TEXT CHECK (detail_challenge_id IS NULL OR length(detail_challenge_id) <= 80 AND length(detail_challenge_id) > 0) CHECK (detail_challenge_id IS NULL OR type IN ('box_challenge_published')),
  detail_session_id                TEXT CHECK (detail_session_id IS NULL OR length(detail_session_id) <= 80 AND length(detail_session_id) > 0) CHECK (detail_session_id IS NULL OR type IN ('box_clip_saved', 'box_result_invalidated', 'box_result_restored')),
  detail_media_id                  TEXT CHECK (detail_media_id IS NULL OR length(detail_media_id) <= 80 AND length(detail_media_id) > 0) CHECK (detail_media_id IS NULL OR type IN ('box_clip_saved')),
  detail_by                        TEXT CHECK (detail_by IS NULL OR length(detail_by) <= 40) CHECK (detail_by IS NULL OR type IN ('box_prefs_changed', 'passport_share_revoked')),
  detail_share                     TEXT CHECK (detail_share IS NULL OR length(detail_share) <= 40) CHECK (detail_share IS NULL OR type IN ('box_prefs_changed')),
  detail_retain_clips              INTEGER CHECK (detail_retain_clips IS NULL OR detail_retain_clips IN (0,1)) CHECK (detail_retain_clips IS NULL OR type IN ('box_prefs_changed')),
  detail_dispute_id                TEXT CHECK (detail_dispute_id IS NULL OR length(detail_dispute_id) <= 80 AND length(detail_dispute_id) > 0) CHECK (detail_dispute_id IS NULL OR type IN ('box_result_invalidated')),
  detail_outcome                   TEXT CHECK (detail_outcome IS NULL OR length(detail_outcome) <= 40) CHECK (detail_outcome IS NULL OR type IN ('box_result_invalidated')),
  detail_reason                    TEXT CHECK (detail_reason IS NULL OR length(detail_reason) <= 300) CHECK (detail_reason IS NULL OR type IN ('box_result_restored', 'level_review')),
  detail_attempt_id                TEXT CHECK (detail_attempt_id IS NULL OR length(detail_attempt_id) <= 80 AND length(detail_attempt_id) > 0) CHECK (detail_attempt_id IS NULL OR type IN ('combine_attempt_completed')),
  detail_protocol                  TEXT CHECK (detail_protocol IS NULL OR length(detail_protocol) <= 120) CHECK (detail_protocol IS NULL OR type IN ('combine_attempt_completed')),
  detail_state                     TEXT CHECK (detail_state IS NULL OR length(detail_state) <= 40) CHECK (detail_state IS NULL OR type IN ('combine_attempt_completed')),
  detail_request_id                TEXT CHECK (detail_request_id IS NULL OR length(detail_request_id) <= 80 AND length(detail_request_id) > 0) CHECK (detail_request_id IS NULL OR type IN ('combine_request_completed', 'combine_request_created')),
  detail_from_value                TEXT CHECK (detail_from_value IS NULL OR length(detail_from_value) <= 40) CHECK (detail_from_value IS NULL OR type IN ('level_review')),
  detail_to_value                  TEXT CHECK (detail_to_value IS NULL OR length(detail_to_value) <= 40) CHECK (detail_to_value IS NULL OR type IN ('level_review')),
  detail_trial_id                  TEXT CHECK (detail_trial_id IS NULL OR length(detail_trial_id) <= 80 AND length(detail_trial_id) > 0) CHECK (detail_trial_id IS NULL OR type IN ('open_trial_posted')),
  detail_via                       TEXT CHECK (detail_via IS NULL OR length(detail_via) <= 40) CHECK (detail_via IS NULL OR type IN ('passport_recruitment_view')),
  detail_mode                      TEXT CHECK (detail_mode IS NULL OR length(detail_mode) <= 40) CHECK (detail_mode IS NULL OR type IN ('passport_share_created')),
  detail_share_id                  TEXT CHECK (detail_share_id IS NULL OR length(detail_share_id) <= 80 AND length(detail_share_id) > 0) CHECK (detail_share_id IS NULL OR type IN ('passport_share_created', 'passport_share_revoked')),
  detail_claim_id                  TEXT CHECK (detail_claim_id IS NULL OR length(detail_claim_id) <= 80 AND length(detail_claim_id) > 0) CHECK (detail_claim_id IS NULL OR type IN ('verification_decision')),
  detail_action                    TEXT CHECK (detail_action IS NULL OR length(detail_action) <= 40) CHECK (detail_action IS NULL OR type IN ('verification_decision')),
  detail_root_request_id           TEXT CHECK (detail_root_request_id IS NULL OR length(detail_root_request_id) <= 80 AND length(detail_root_request_id) > 0) CHECK (detail_root_request_id IS NULL OR type IN ('verification_root_approved')),
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES org_users(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ledger_player_id_type ON ledger (player_id, type);
CREATE INDEX ledger_player_id_org_id ON ledger (player_id, org_id);
CREATE INDEX ledger_org_id_type ON ledger (org_id, type);
CREATE INDEX ledger_actor ON ledger (actor_name, org_name, type);
CREATE TABLE ledger_protocols (
  ledger_id TEXT NOT NULL,
  ord INTEGER NOT NULL CHECK (ord >= 0),
  protocol TEXT NOT NULL CHECK (length(protocol) > 0 AND length(protocol) <= 120),
  PRIMARY KEY (ledger_id, ord),
  FOREIGN KEY (ledger_id) REFERENCES ledger(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE ops_events (
  seq                              INTEGER PRIMARY KEY,
  id                               TEXT NOT NULL UNIQUE CHECK (length(id) > 0 AND length(id) <= 80),
  occurred_at                      INTEGER NOT NULL,
  kind                             TEXT NOT NULL CHECK (kind IN ('staff_bootstrapped','audit_export','backup_created','backup_refused','backup_failed','delivery_failed','webhook_failed')),
  detail_org_id                    TEXT CHECK (detail_org_id IS NULL OR length(detail_org_id) <= 80 AND length(detail_org_id) > 0) CHECK (detail_org_id IS NULL OR kind IN ('staff_bootstrapped', 'audit_export')),
  detail_user_id                   TEXT CHECK (detail_user_id IS NULL OR length(detail_user_id) <= 80 AND length(detail_user_id) > 0) CHECK (detail_user_id IS NULL OR kind IN ('staff_bootstrapped')),
  detail_by                        TEXT CHECK (detail_by IS NULL OR length(detail_by) <= 200) CHECK (detail_by IS NULL OR kind IN ('staff_bootstrapped', 'audit_export')),
  detail_dir                       TEXT CHECK (detail_dir IS NULL OR length(detail_dir) <= 200) CHECK (detail_dir IS NULL OR kind IN ('backup_created', 'backup_refused', 'backup_failed')),
  detail_files                     INTEGER CHECK (detail_files IS NULL OR kind IN ('backup_created')),
  detail_queued_for_removal        INTEGER CHECK (detail_queued_for_removal IS NULL OR kind IN ('backup_created')),
  detail_error                     TEXT CHECK (detail_error IS NULL OR length(detail_error) <= 300) CHECK (detail_error IS NULL OR kind IN ('backup_refused', 'backup_failed')),
  detail_conflict_count            INTEGER CHECK (detail_conflict_count IS NULL OR kind IN ('backup_refused')),
  detail_dispatch_id               TEXT CHECK (detail_dispatch_id IS NULL OR length(detail_dispatch_id) <= 80 AND length(detail_dispatch_id) > 0) CHECK (detail_dispatch_id IS NULL OR kind IN ('delivery_failed')),
  detail_channel                   TEXT CHECK (detail_channel IS NULL OR length(detail_channel) <= 40) CHECK (detail_channel IS NULL OR kind IN ('delivery_failed')),
  detail_delivery_id               TEXT CHECK (detail_delivery_id IS NULL OR length(detail_delivery_id) <= 80 AND length(detail_delivery_id) > 0) CHECK (detail_delivery_id IS NULL OR kind IN ('webhook_failed')),
  detail_endpoint_id               TEXT CHECK (detail_endpoint_id IS NULL OR length(detail_endpoint_id) <= 80 AND length(detail_endpoint_id) > 0) CHECK (detail_endpoint_id IS NULL OR kind IN ('webhook_failed')),
  FOREIGN KEY (detail_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (detail_user_id) REFERENCES org_users(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ops_events_kind ON ops_events (kind);
CREATE TABLE source_changes (
  seq                              INTEGER PRIMARY KEY,
  id                               TEXT NOT NULL UNIQUE CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                        TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  type                             TEXT NOT NULL CHECK (type IN ('position_changed')),
  source_system                    TEXT NOT NULL CHECK (source_system IN ('passport_prefs','position_history')),
  source_id                        TEXT CHECK (source_id IS NULL OR length(source_id) <= 200 AND length(source_id) > 0),
  occurred_at                      INTEGER NOT NULL,
  detail_position_from             TEXT CHECK (detail_position_from IS NULL OR length(detail_position_from) <= 40) CHECK (detail_position_from IS NULL OR type IN ('position_changed')),
  detail_position_to               TEXT CHECK (detail_position_to IS NULL OR length(detail_position_to) <= 40) CHECK (detail_position_to IS NULL OR type IN ('position_changed')),
  detail_submitted_by              TEXT CHECK (detail_submitted_by IS NULL OR length(detail_submitted_by) <= 40) CHECK (detail_submitted_by IS NULL OR type IN ('position_changed'))
) STRICT;
CREATE INDEX source_changes_player_id_occurred_at ON source_changes (player_id, occurred_at);
CREATE TABLE idv_queue (
  seq                              INTEGER PRIMARY KEY,
  id                               TEXT NOT NULL UNIQUE CHECK (length(id) > 0 AND length(id) <= 80),
  guardian_id                      TEXT NOT NULL CHECK (length(guardian_id) <= 80 AND length(guardian_id) > 0),
  guardian_name                    TEXT CHECK (guardian_name IS NULL OR length(guardian_name) <= 200),
  document_type                    TEXT NOT NULL CHECK (length(document_type) <= 60 AND length(document_type) > 0),
  document_ref_last4               TEXT NOT NULL CHECK (length(document_ref_last4) <= 20),
  provider                         TEXT NOT NULL CHECK (length(provider) <= 60 AND length(provider) > 0),
  reference                        TEXT NOT NULL CHECK (length(reference) <= 200 AND length(reference) > 0),
  created_at                       INTEGER NOT NULL,
  status                           TEXT NOT NULL CHECK (status IN ('approved','revoked'))
) STRICT;
CREATE INDEX idv_queue_guardian_id ON idv_queue (guardian_id);
