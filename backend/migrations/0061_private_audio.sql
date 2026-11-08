-- Audio carries the scope of its source, including previews. Unreferenced legacy
-- clips stay private; only clips exclusively used by public snapshots may migrate.
ALTER TABLE tts_audio_assets ADD COLUMN private_source BOOLEAN NOT NULL DEFAULT true;
UPDATE tts_audio_assets a SET private_source=false
WHERE EXISTS (SELECT 1 FROM presentation_events e JOIN log_presentations p ON p.id=e.presentation_id
              JOIN log_snapshots s ON s.id=p.snapshot_id WHERE e.audio_asset_id=a.id AND s.scope='pl_public')
  AND NOT EXISTS (SELECT 1 FROM presentation_events e JOIN log_presentations p ON p.id=e.presentation_id
                  JOIN log_snapshots s ON s.id=p.snapshot_id WHERE e.audio_asset_id=a.id AND s.scope<>'pl_public');
-- Existing public bucket copies require operator removal and CDN invalidation;
-- changing database metadata cannot revoke copies already downloaded.
