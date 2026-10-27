-- Lines the Keeper posted as an NPC were synced as narration. They are the NPC speaking.
UPDATE log_events SET event_type='dialogue'
 WHERE source_kind='channel_event' AND speaker_role='npc' AND event_type='narration' AND speaker_character_id IS NOT NULL;
