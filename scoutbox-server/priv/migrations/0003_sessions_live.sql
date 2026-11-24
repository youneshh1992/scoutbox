-- 0003_sessions_live: sessions become table-backed (token hashes only)

INSERT INTO meta (key, value) VALUES ('sessionTtlMs', '__SESSION_TTL_MS__') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
