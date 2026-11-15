-- Safety and audit: blocks, reports, the moderation log, club notes and operations events.
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
CREATE INDEX blocks_org_id ON blocks (org_id);
CREATE INDEX blocks_player_id_org_id ON blocks (player_id, org_id);
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
CREATE INDEX reports_status_created_at ON reports (status, created_at);
CREATE INDEX reports_target_org_id_urgent_status ON reports (target_org_id, urgent, status);
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
