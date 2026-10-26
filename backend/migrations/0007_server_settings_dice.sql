-- 0007_server_settings_dice: per-server maintainer settings, Sealdice-style dice reply texts, dice results on messages

-- One row per server, written by its maintainers (server owner/admins). API keys are sealed with AES-256-GCM
-- (see crypto::sealSecret) and never returned to clients. Empty LLM fields fall back to the process config.
CREATE TABLE server_settings (
    server_id            UUID PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    language             TEXT NOT NULL DEFAULT 'en',
    llm_api_base         TEXT NOT NULL DEFAULT '',
    llm_api_key_sealed   TEXT NOT NULL DEFAULT '',
    llm_api_key_hint     TEXT NOT NULL DEFAULT '',
    llm_model            TEXT NOT NULL DEFAULT '',
    llm_reasoning_effort TEXT NOT NULL DEFAULT '' CHECK (llm_reasoning_effort IN ('','minimal','low','medium','high')),
    tts_api_base         TEXT NOT NULL DEFAULT '',
    tts_api_key_sealed   TEXT NOT NULL DEFAULT '',
    tts_api_key_hint     TEXT NOT NULL DEFAULT '',
    tts_model            TEXT NOT NULL DEFAULT '',
    tts_voice            TEXT NOT NULL DEFAULT '',
    feature_consistency  BOOLEAN NOT NULL DEFAULT true,
    feature_dice         BOOLEAN NOT NULL DEFAULT true,
    feature_inspiration  BOOLEAN NOT NULL DEFAULT true,
    updated_by           UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Custom dice reply texts ("文案"). `texts` overrides any subset of the built-in keys on top of `base` ('en' | 'zh').
CREATE TABLE dice_text_groups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    base        TEXT NOT NULL DEFAULT 'en' CHECK (base IN ('en','zh')),
    texts       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (server_id, name)
);

-- The GM picks the text group per channel: '' = follow the server language, 'builtin:en' / 'builtin:zh', or a group id.
ALTER TABLE channels ADD COLUMN dice_text_group TEXT NOT NULL DEFAULT '';

-- Dice commands keep what the user typed in `content`; the evaluated outcome lives here.
ALTER TABLE messages ADD COLUMN dice JSONB;

-- Character attributes move to sheet.attrs (numeric top-level fields and the legacy "skills" object are folded in).
UPDATE characters SET sheet = (sheet - 'skills') || jsonb_build_object('attrs', coalesce((
    SELECT jsonb_object_agg(k, v) FROM (
        SELECT key AS k, value AS v FROM jsonb_each(CASE WHEN jsonb_typeof(sheet->'skills') = 'object' THEN sheet->'skills' ELSE '{}'::jsonb END) WHERE jsonb_typeof(value) = 'number'
        UNION ALL
        SELECT key, value FROM jsonb_each(sheet) WHERE jsonb_typeof(value) = 'number'
    ) x), '{}'::jsonb))
WHERE NOT sheet ? 'attrs';
UPDATE characters SET sheet = sheet - (SELECT coalesce(array_agg(key), '{}') FROM jsonb_each(sheet) WHERE jsonb_typeof(value) = 'number');
