-- 0042_clip_blobs: A clip's file, and a queued removal of one, name the object in storage that holds it (an upload's id)

ALTER TABLE player_media ADD COLUMN blob_key TEXT CHECK (blob_key IS NULL OR length(blob_key) > 0 AND length(blob_key) <= 80);
ALTER TABLE media_deletions ADD COLUMN blob_key TEXT CHECK (blob_key IS NULL OR length(blob_key) > 0 AND length(blob_key) <= 80);
