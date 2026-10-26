-- Message IDs are links, not a copied excerpt: each reader must pass the original message's access check.
ALTER TABLE messages ADD COLUMN reference_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE messages ADD CONSTRAINT bounded_message_references CHECK(cardinality(reference_ids)<=5);
ALTER TABLE pdf_render_jobs ADD COLUMN kp_memory BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE pdf_render_jobs ADD COLUMN memory_group_id UUID REFERENCES player_groups(id);
ALTER TABLE pdf_render_jobs ADD COLUMN memory_group_version INTEGER;
-- Existing exported appendices came from the old shared memory. Preserve the files for KP only.
UPDATE pdf_render_jobs SET kp_memory=true WHERE jsonb_array_length(coalesce(render_payload->'appendices','[]'::jsonb))>0;

-- Retire old share links containing shared-memory appendices; KP retains the original export.
UPDATE published_logs SET revoked=true,revoked_at=now() WHERE pdf_job_id IN (SELECT id FROM pdf_render_jobs WHERE kp_memory);
ALTER TABLE consistency_checks ADD COLUMN player_group_id UUID REFERENCES player_groups(id);
ALTER TABLE consistency_checks ADD COLUMN player_group_version INTEGER;
