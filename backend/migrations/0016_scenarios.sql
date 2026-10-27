-- Scenes become scenarios: stages of the story that the Keeper's observer can open automatically when the
-- chat shows the story moving on. A closed scenario carries an AI summary of what happened in it, so the
-- scenario list doubles as the story's index, and chat can be located by scenario or by time.
ALTER TABLE scenes ADD COLUMN auto_detected BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE scenes ADD COLUMN stage_reason TEXT NOT NULL DEFAULT '';              -- why the observer opened it
ALTER TABLE scenes ADD COLUMN boundary_event_id UUID REFERENCES events(id) ON DELETE SET NULL;
ALTER TABLE scenes ADD COLUMN summary_status TEXT NOT NULL DEFAULT 'none' CHECK (summary_status IN ('none','pending','ready','gm_edited'));
ALTER TABLE scenes ADD COLUMN summary_llm_mode TEXT NOT NULL DEFAULT '';
ALTER TABLE scenes ADD COLUMN key_points JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE scenes ADD COLUMN summary_source_event_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE scenes ADD COLUMN summarized_at TIMESTAMPTZ;
-- Existing GM-written summaries stay authoritative.
UPDATE scenes SET summary_status='gm_edited' WHERE summary <> '';
ALTER TABLE channels ADD COLUMN auto_scenarios BOOLEAN NOT NULL DEFAULT true;
