-- The mail outbox. On the dev transport the outbox is the delivery.
CREATE TABLE outbox (
  seq                 INTEGER PRIMARY KEY,
  id                  TEXT NOT NULL UNIQUE CHECK (id IS NULL OR length(id) BETWEEN 1 AND 80),
  source              TEXT NOT NULL CHECK (source IN ('mailer', 'delivery')),
  created_at          INTEGER NOT NULL,
  to_address          TEXT NOT NULL CHECK (to_address IS NULL OR length(to_address) BETWEEN 1 AND 320),
  subject             TEXT CHECK (subject IS NULL OR length(subject) BETWEEN 0 AND 300),
  text                TEXT NOT NULL CHECK (text IS NULL OR length(text) BETWEEN 0 AND 10000),
  transport           TEXT NOT NULL CHECK (transport IN ('sendgrid', 'dev-outbox', 'local-fake')),
  delivered           INTEGER,
  channel             TEXT CHECK (channel IS NULL OR channel = 'email'),
  provider_message_id TEXT CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 80),
  CHECK ((source = 'mailer' AND subject IS NOT NULL AND delivered IS NOT NULL AND delivered IN (0, 1) AND channel IS NULL AND provider_message_id IS NULL AND transport IN ('sendgrid', 'dev-outbox'))
      OR (source = 'delivery' AND subject IS NULL AND delivered IS NULL AND channel IS NOT NULL AND provider_message_id IS NOT NULL AND transport = 'local-fake' AND length(text) <= 300))
) STRICT;
