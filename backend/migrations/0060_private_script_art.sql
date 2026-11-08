-- Previously generated private-script art must also leave the channel library.
UPDATE media_assets m SET visibility_scope='gm',
    source_reference=m.source_reference || jsonb_build_object('private_presentation_id',p.id::text)
FROM asset_generation_jobs j
JOIN log_presentations p ON p.id::text=j.params->'attach'->>'presentation_id'
JOIN log_snapshots s ON s.id=p.snapshot_id
WHERE m.id=j.result_asset_id AND s.scope<>'pl_public';
-- Older private poses may have replaced a shared character's slot; retain them only in their own presentation.
UPDATE characters SET portrait_asset_id=NULL WHERE portrait_asset_id IN
    (SELECT id FROM media_assets WHERE source_reference ? 'private_presentation_id');
UPDATE character_visual_profiles SET default_asset_id=NULL WHERE default_asset_id IN
    (SELECT id FROM media_assets WHERE source_reference ? 'private_presentation_id');
UPDATE character_visual_profiles cv SET expressions=(
    SELECT coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb)
    FROM jsonb_each(cv.expressions) e
    WHERE NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.id::text=e.value#>>'{}' AND m.source_reference ? 'private_presentation_id')
) WHERE jsonb_typeof(cv.expressions)='object';
