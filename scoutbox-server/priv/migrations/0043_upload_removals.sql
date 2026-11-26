-- 0043_upload_removals: When the sweep removed an expired upload's file from storage. Until then the sweep tries
-- again; only an expired upload's file is ever removed this way.

ALTER TABLE upload_intents ADD COLUMN removed_at INTEGER CHECK (removed_at IS NULL OR status = 'expired');
