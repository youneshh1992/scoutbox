-- Contact and trial requests from organisations. The case and trial references arrive with those tables.
CREATE TABLE recruitment_requests (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  player_name TEXT,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name TEXT NOT NULL,
  org_type TEXT CHECK (org_type IS NULL OR org_type IN ('club','agency')),
  org_verified INTEGER NOT NULL CHECK (org_verified IS NULL OR org_verified IN (0,1)),
  org_safeguarding_certified INTEGER NOT NULL CHECK (org_safeguarding_certified IS NULL OR org_safeguarding_certified IN (0,1)),
  org_trusted_partner INTEGER CHECK (org_trusted_partner IS NULL OR org_trusted_partner IN (0,1)),
  user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  scout_name TEXT,
  scout_role TEXT,
  type TEXT NOT NULL CHECK (type IS NULL OR type IN ('contact','trial')),
  message TEXT,
  subject TEXT,
  contact_id TEXT,
  trial_proposed_date TEXT CHECK (trial_proposed_date IS NULL OR trial_proposed_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  trial_alt_days_json TEXT CHECK (trial_alt_days_json IS NULL OR (json_valid(trial_alt_days_json) AND json_type(trial_alt_days_json) = 'array')),
  trial_venue TEXT,
  trial_notes TEXT,
  trial_private_venue_address TEXT CHECK (trial_private_venue_address IS NULL OR length(trial_private_venue_address) <= 200),
  trial_private_instructions TEXT CHECK (trial_private_instructions IS NULL OR length(trial_private_instructions) <= 500),
  status TEXT NOT NULL CHECK (status IS NULL OR status IN ('pending','accepted','declined','suspended')),
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  responded_by TEXT CHECK (responded_by IS NULL OR responded_by IN ('player','guardian')),
  routed_to TEXT NOT NULL CHECK (routed_to IS NULL OR routed_to IN ('player','guardian')),
  guardian_id TEXT,
  contact_channel_id TEXT,
  case_id TEXT,
  trial_id TEXT,
  recipient_type TEXT CHECK (recipient_type IS NULL OR recipient_type IN ('player','guardian')),
  recipient_player_id TEXT,
  recipient_guardian_id TEXT,
  recipient_minor INTEGER CHECK (recipient_minor IS NULL OR recipient_minor IN (0,1)),
  invite_key TEXT CHECK (invite_key IS NULL OR length(invite_key) <= 64),
  invite_fp TEXT,
  subject_removed_at INTEGER,
  CHECK ((type = 'trial') = (trial_alt_days_json IS NOT NULL)),
  CHECK ((recipient_type IS NULL) = (recipient_minor IS NULL)),
  CHECK ((invite_key IS NULL) = (invite_fp IS NULL))
) STRICT;
CREATE INDEX recruitment_requests_case_type_created ON recruitment_requests (case_id, type, created_at);
CREATE INDEX recruitment_requests_contact ON recruitment_requests (contact_id);
CREATE INDEX recruitment_requests_org ON recruitment_requests (org_id);
CREATE INDEX recruitment_requests_org_player_type_status ON recruitment_requests (org_id, player_id, type, status);
CREATE INDEX recruitment_requests_player ON recruitment_requests (player_id, created_at);
CREATE INDEX recruitment_requests_routed_guardian ON recruitment_requests (routed_to, guardian_id);
CREATE INDEX recruitment_requests_trial ON recruitment_requests (trial_id);
