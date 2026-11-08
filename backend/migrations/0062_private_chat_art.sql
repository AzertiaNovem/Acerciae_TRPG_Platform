-- Illustrations inherit a message audience; even a current public-window picture
-- is not a permanent public publication. Retain the origin when metadata changes.
UPDATE media_assets m
SET source_reference = m.source_reference || jsonb_build_object('private_chat_window_id', j.params->'attach'->'window_id')
FROM asset_generation_jobs j
WHERE j.kind='illustration' AND m.source_reference->>'job_id'=j.id::text
  AND jsonb_typeof(j.params->'attach'->'window_id')='string';
