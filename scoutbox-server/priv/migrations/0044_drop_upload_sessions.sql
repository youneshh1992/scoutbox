-- 0044_drop_upload_sessions: The chunked upload's sessions and chunks are dropped: files go straight to object storage
-- through upload_intents (0041)

DROP TABLE IF EXISTS upload_session_chunks;
DROP TABLE IF EXISTS upload_sessions;
