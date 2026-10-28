-- AI belongs to each server's maintainers: the platform no longer supplies providers, models or keys.
-- A server without its own provider runs the clearly labelled mock (rule-based) mode.

-- LLM: '' meant "inherit the platform"; it becomes mock unless the server already brought its own key.
ALTER TABLE server_settings DROP CONSTRAINT server_settings_llm_provider_check;
UPDATE server_settings SET llm_provider = CASE
    WHEN llm_api_key_sealed = '' THEN 'mock'
    WHEN llm_provider = '' THEN 'openai_compatible'
    ELSE llm_provider END;
ALTER TABLE server_settings ALTER COLUMN llm_provider SET DEFAULT 'mock';
ALTER TABLE server_settings ADD CONSTRAINT server_settings_llm_provider_check CHECK (llm_provider IN ('mock', 'openai_compatible', 'anthropic'));
ALTER TABLE server_settings ADD COLUMN llm_embedding_model TEXT NOT NULL DEFAULT '';

-- Images: "inherit" no longer exists.
ALTER TABLE server_settings DROP CONSTRAINT server_settings_image_provider_check;
UPDATE server_settings SET image_provider = 'disabled' WHERE image_provider = 'inherit';
ALTER TABLE server_settings ALTER COLUMN image_provider SET DEFAULT 'disabled';
ALTER TABLE server_settings ADD CONSTRAINT server_settings_image_provider_check CHECK (image_provider IN ('disabled', 'mock', 'gpt_image'));

-- Speech: explicit provider instead of "a key means Qwen".
ALTER TABLE server_settings ADD COLUMN tts_provider TEXT NOT NULL DEFAULT 'mock' CHECK (tts_provider IN ('disabled', 'mock', 'qwen'));
UPDATE server_settings SET tts_provider = 'qwen' WHERE tts_api_key_sealed <> '';

-- AI policy: a token budget for the whole server (per calendar month or in total since the last reset), an image
-- budget for the same period, and how many AI calls the server may run at the same time.
ALTER TABLE server_settings
    ADD COLUMN ai_token_budget BIGINT NOT NULL DEFAULT 0 CHECK (ai_token_budget >= 0),          -- 0 = unlimited
    ADD COLUMN ai_image_budget INT NOT NULL DEFAULT 0 CHECK (ai_image_budget >= 0),             -- 0 = unlimited
    ADD COLUMN ai_budget_period TEXT NOT NULL DEFAULT 'month' CHECK (ai_budget_period IN ('month', 'total')),
    ADD COLUMN ai_usage_reset_at TIMESTAMPTZ,
    ADD COLUMN ai_max_concurrent INT NOT NULL DEFAULT 4 CHECK (ai_max_concurrent BETWEEN 1 AND 64);

CREATE TABLE ai_usage_records (
    id                BIGSERIAL PRIMARY KEY,
    server_id         UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id        UUID REFERENCES channels(id) ON DELETE SET NULL,
    kind              TEXT NOT NULL CHECK (kind IN ('llm', 'embedding', 'image')),
    task              TEXT NOT NULL DEFAULT '',
    prompt_tokens     INT NOT NULL DEFAULT 0,
    completion_tokens INT NOT NULL DEFAULT 0,
    images            INT NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_records_server_time ON ai_usage_records (server_id, created_at);
