-- Visual-novel scripts: a part whose answer asks the players or the Keeper something waits for their answers while the
-- other parts go on. The job is then 'waiting'; the part's row keeps the questions, the model's draft answer, the
-- exchange to replay when the part is resumed (the model's own turn, thinking blocks and all) and, once given, the
-- answers.
ALTER TABLE vn_script_jobs DROP CONSTRAINT IF EXISTS vn_script_jobs_status_check;
ALTER TABLE vn_script_jobs ADD CONSTRAINT vn_script_jobs_status_check CHECK (status IN ('pending','running','waiting','completed','failed','cancelled'));
ALTER TABLE vn_script_chunks ADD COLUMN questions JSONB;   -- {items:[{id, question, refs, options}], first_line, last_line} while waiting
ALTER TABLE vn_script_chunks ADD COLUMN answers JSONB;     -- {q1: "...", ...} or {skip: true} once the user answered
ALTER TABLE vn_script_chunks ADD COLUMN exchange JSONB;    -- {provider, model, content, provider_content}: the model's turn to replay
ALTER TABLE vn_script_chunks ADD COLUMN rounds INTEGER NOT NULL DEFAULT 0;   -- how often this part asked
