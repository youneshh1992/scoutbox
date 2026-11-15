-- Guardian ID checks, in the order they happened, and Trust & Safety's review of each.
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
