-- Earlier versions froze events but still read mutable project metadata.
ALTER TABLE log_snapshots ADD COLUMN frozen_metadata JSONB NOT NULL DEFAULT '{}';
UPDATE log_snapshots s SET frozen_metadata=jsonb_build_object('project_title',p.title,'character_map',
  coalesce((SELECT jsonb_object_agg(e.frozen_event->>'speaker_key',jsonb_strip_nulls(jsonb_build_object(
    'display_name',e.frozen_event->>'speaker_display_name','role',e.frozen_event->>'speaker_role',
    'character_id',e.frozen_event->>'speaker_character_id',
    'color',CASE WHEN p.character_map->(e.frozen_event->>'speaker_key')->>'color' ~ '^#[0-9a-fA-F]{6}$'
      THEN p.character_map->(e.frozen_event->>'speaker_key')->>'color' END)))
  FROM log_snapshot_events e WHERE e.snapshot_id=s.id),'{}'::jsonb))
FROM log_projects p WHERE p.id=s.project_id;
