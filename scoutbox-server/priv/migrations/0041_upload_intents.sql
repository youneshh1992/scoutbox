-- 0041_upload_intents: A file is uploaded straight to object storage on a URL the server signs; the intent records what was declared, and which record the upload became

-- id is also the object's key in storage: random, so it never repeats, even across databases sharing a bucket.
-- owner_id is a player, an organisation user, or the root application whose secret an applicant holds.
-- record_id is the record the upload became: a clip or an evidence record, by purpose.
CREATE TABLE upload_intents (
  id          TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  purpose     TEXT NOT NULL CHECK (purpose IN ('player_clip','verification_evidence','signing_document')),
  owner_kind  TEXT NOT NULL CHECK (owner_kind IN ('player','org_user','applicant')),
  owner_id    TEXT NOT NULL CHECK (length(owner_id) > 0 AND length(owner_id) <= 80),
  size_bytes  INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 41943040),
  mime        TEXT NOT NULL CHECK (length(mime) > 0 AND length(mime) <= 100),
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
  status      TEXT NOT NULL CHECK (status IN ('open','used','expired')),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  record_id   TEXT CHECK (record_id IS NULL OR length(record_id) > 0 AND length(record_id) <= 80),
  used_at     INTEGER,
  CHECK ((status = 'used') = (record_id IS NOT NULL)),
  CHECK ((status = 'used') = (used_at IS NOT NULL))
) STRICT;
CREATE INDEX upload_intents_owner ON upload_intents (owner_kind, owner_id, status);
CREATE INDEX upload_intents_open ON upload_intents (expires_at) WHERE status = 'open';
