-- The id counter: every record id is <prefix>-<n> with n from here, starting above 1000.
CREATE TABLE counters (
  name  TEXT PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 40),
  value INTEGER NOT NULL CHECK (value >= 0)
) STRICT;
INSERT INTO counters (name, value) VALUES ('id', 1000);
