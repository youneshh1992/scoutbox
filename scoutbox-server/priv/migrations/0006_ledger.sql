-- The Discovery Ledger: append-only. The TypeScript table also has detail_* columns for the events of
-- domains this server does not run yet; they arrive with those domains.
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
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES org_users(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ledger_org_id_type ON ledger (org_id, type);
