-- 0066_ai_providers: AI is configured as named providers and model uses.
-- A server's maintainers add providers (an endpoint of a known kind with its keys), then assign a provider and model to
-- each use: text (plus optional text overrides per kind of work), embedding, image generation, image editing, speech.
-- The old single llm_/image_/tts_ columns are migrated here and no longer read (kept for rollback).
CREATE TABLE server_ai_providers (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id      UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('openai', 'anthropic', 'responses', 'google', 'aws', 'alibaba', 'openrouter', 'volcengine', 'stability')),
    api_base       TEXT NOT NULL DEFAULT '',          -- '' = the kind's default endpoint
    api_key_sealed TEXT NOT NULL DEFAULT '',          -- the main secret (AES-256-GCM, see crypto::sealSecret)
    api_key_hint   TEXT NOT NULL DEFAULT '',
    options        JSONB NOT NULL DEFAULT '{}',       -- the kind's other plain fields (region, access key id, app id…)
    secrets        JSONB NOT NULL DEFAULT '{}',       -- the kind's other secrets: {field: {sealed, hint}}
    created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (server_id, name)
);
CREATE INDEX server_ai_providers_server ON server_ai_providers(server_id);

-- One row per configured use. mode: provider (provider_id + model), mock (rule-based text, test images, tone audio),
-- disabled, or inherit (a text override follows "text"; image editing follows image generation).
CREATE TABLE server_ai_uses (
    server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    use         TEXT NOT NULL CHECK (use IN ('text', 'text_chronicle', 'text_assist', 'text_writing', 'embedding', 'image_generation', 'image_edit', 'tts')),
    mode        TEXT NOT NULL CHECK (mode IN ('provider', 'mock', 'disabled', 'inherit')),
    provider_id UUID REFERENCES server_ai_providers(id) ON DELETE SET NULL,
    model       TEXT NOT NULL DEFAULT '',
    options     JSONB NOT NULL DEFAULT '{}',          -- reasoning_effort; size, quality; voice
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, use)
);   -- a 'provider' row whose provider is gone (provider_id NULL) counts as unset

-- Migrate the old columns. The sealed keys are copied as they are (same sealing).
INSERT INTO server_ai_providers(server_id, name, kind, api_base, api_key_sealed, api_key_hint)
SELECT server_id, 'Language model', CASE llm_provider WHEN 'anthropic' THEN 'anthropic' ELSE 'responses' END,
       llm_api_base, llm_api_key_sealed, llm_api_key_hint
FROM server_settings WHERE llm_provider IN ('openai_compatible', 'anthropic') AND llm_api_key_sealed <> '';
INSERT INTO server_ai_uses(server_id, use, mode, provider_id, model, options)
SELECT p.server_id, 'text', 'provider', p.id, ss.llm_model,
       CASE WHEN ss.llm_reasoning_effort <> '' THEN jsonb_build_object('reasoning_effort', ss.llm_reasoning_effort) ELSE '{}'::jsonb END
FROM server_ai_providers p JOIN server_settings ss ON ss.server_id = p.server_id WHERE p.name = 'Language model';
INSERT INTO server_ai_uses(server_id, use, mode, provider_id, model)
SELECT p.server_id, 'embedding', 'provider', p.id, ss.llm_embedding_model
FROM server_ai_providers p JOIN server_settings ss ON ss.server_id = p.server_id
WHERE p.name = 'Language model' AND p.kind = 'responses' AND ss.llm_embedding_model <> '';

-- The old settings kept a key with the mock mode (switching back reused it): the text use remembers it.
INSERT INTO server_ai_providers(server_id, name, kind, api_base, api_key_sealed, api_key_hint)
SELECT server_id, 'Language model', 'responses', llm_api_base, llm_api_key_sealed, llm_api_key_hint
FROM server_settings WHERE llm_provider NOT IN ('openai_compatible', 'anthropic') AND llm_api_key_sealed <> '';
INSERT INTO server_ai_uses(server_id, use, mode, provider_id, model)
SELECT p.server_id, 'text', 'mock', p.id, ss.llm_model
FROM server_ai_providers p JOIN server_settings ss ON ss.server_id = p.server_id
WHERE p.name = 'Language model' AND ss.llm_provider NOT IN ('openai_compatible', 'anthropic');

INSERT INTO server_ai_providers(server_id, name, kind, api_base, api_key_sealed, api_key_hint)
SELECT server_id, 'Images', 'openai', image_api_base, image_api_key_sealed, image_api_key_hint
FROM server_settings WHERE image_provider = 'gpt_image' AND image_api_key_sealed <> '';
INSERT INTO server_ai_uses(server_id, use, mode, provider_id, model, options)
SELECT p.server_id, u.use, 'provider', p.id, ss.image_model, jsonb_build_object('size', ss.image_size, 'quality', ss.image_quality)
FROM server_ai_providers p JOIN server_settings ss ON ss.server_id = p.server_id CROSS JOIN (VALUES ('image_generation'), ('image_edit')) AS u(use)
WHERE p.name = 'Images';
INSERT INTO server_ai_providers(server_id, name, kind, api_base, api_key_sealed, api_key_hint)
SELECT server_id, 'Images', 'openai', image_api_base, image_api_key_sealed, image_api_key_hint
FROM server_settings WHERE image_provider IN ('mock', 'disabled') AND image_api_key_sealed <> '';
INSERT INTO server_ai_uses(server_id, use, mode, provider_id, model, options)
SELECT ss.server_id, 'image_generation', ss.image_provider, p.id, ss.image_model, jsonb_build_object('size', ss.image_size, 'quality', ss.image_quality)
FROM server_settings ss LEFT JOIN server_ai_providers p ON p.server_id = ss.server_id AND p.name = 'Images'
WHERE ss.image_provider IN ('mock', 'disabled')
ON CONFLICT DO NOTHING;

INSERT INTO server_ai_providers(server_id, name, kind, api_base, api_key_sealed, api_key_hint)
SELECT server_id, 'Voice', CASE tts_provider WHEN 'qwen' THEN 'alibaba' ELSE 'openai' END, tts_api_base, tts_api_key_sealed, tts_api_key_hint
FROM server_settings WHERE tts_provider IN ('qwen', 'openai') AND tts_api_key_sealed <> '';
INSERT INTO server_ai_uses(server_id, use, mode, provider_id, model, options)
SELECT p.server_id, 'tts', 'provider', p.id, ss.tts_model,
       CASE WHEN ss.tts_voice <> '' THEN jsonb_build_object('voice', ss.tts_voice) ELSE '{}'::jsonb END
FROM server_ai_providers p JOIN server_settings ss ON ss.server_id = p.server_id WHERE p.name = 'Voice';
INSERT INTO server_ai_providers(server_id, name, kind, api_base, api_key_sealed, api_key_hint)
SELECT server_id, 'Voice', 'alibaba', tts_api_base, tts_api_key_sealed, tts_api_key_hint
FROM server_settings WHERE tts_provider IN ('mock', 'disabled') AND tts_api_key_sealed <> '';
INSERT INTO server_ai_uses(server_id, use, mode, provider_id, model, options)
SELECT ss.server_id, 'tts', ss.tts_provider, p.id, ss.tts_model, CASE WHEN ss.tts_voice <> '' THEN jsonb_build_object('voice', ss.tts_voice) ELSE '{}'::jsonb END
FROM server_settings ss LEFT JOIN server_ai_providers p ON p.server_id = ss.server_id AND p.name = 'Voice'
WHERE ss.tts_provider IN ('mock', 'disabled')
ON CONFLICT DO NOTHING;
-- A Qwen or OpenAI speech provider without a key ran with speech off.
INSERT INTO server_ai_uses(server_id, use, mode)
SELECT server_id, 'tts', 'disabled' FROM server_settings WHERE tts_provider IN ('qwen', 'openai') AND tts_api_key_sealed = ''
ON CONFLICT DO NOTHING;
