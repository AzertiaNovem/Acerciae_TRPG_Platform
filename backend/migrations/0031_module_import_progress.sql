ALTER TABLE modules
 ADD COLUMN source_hash TEXT,
 ADD COLUMN import_stage TEXT NOT NULL DEFAULT '',
 ADD COLUMN completed_chunks INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN total_chunks INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN import_warning TEXT;
CREATE UNIQUE INDEX modules_source_once ON modules(channel_id,source_hash) WHERE source_hash IS NOT NULL;
UPDATE modules SET import_stage=CASE WHEN status IN ('ready','failed') THEN status ELSE 'queued' END;
