-- 0007_logstudio: Log Studio — canonical logs, snapshots, imports, presentations, media, TTS, PDF, publishing.
-- Three strictly separated layers: canonical log (what happened), presentation (how it is performed),
-- publication configuration (how it is typeset). Large media lives in object storage; only metadata here.

CREATE TABLE log_projects (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    source_kind   TEXT NOT NULL DEFAULT 'channel' CHECK (source_kind IN ('channel','import','mixed')),
    character_map JSONB NOT NULL DEFAULT '{}'::jsonb,   -- speaker_key -> {character_id, display_name, role, color}
    version       INTEGER NOT NULL DEFAULT 1,
    created_by    UUID REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX log_projects_channel_idx ON log_projects(channel_id);

-- Canonical log events. Original text is preserved verbatim; AI never rewrites `content`.
CREATE TABLE log_events (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id           UUID NOT NULL REFERENCES log_projects(id) ON DELETE CASCADE,
    channel_id           UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    sequence_number      BIGINT NOT NULL,
    event_type           TEXT NOT NULL CHECK (event_type IN ('dialogue','action','narration','dice_roll','system','ooc','scene_change','media','secret')),
    content              TEXT NOT NULL,
    speaker_key          TEXT NOT NULL DEFAULT '',          -- stable key (character id or "<nick>-<imid>")
    speaker_display_name TEXT NOT NULL DEFAULT '',
    speaker_character_id UUID REFERENCES characters(id) ON DELETE SET NULL,
    speaker_role         TEXT NOT NULL DEFAULT 'pc' CHECK (speaker_role IN ('gm','pc','npc','dice','system','hidden')),
    occurred_at          TIMESTAMPTZ,
    time_text            TEXT,                              -- unparseable original time, preserved
    scene_key            TEXT NOT NULL DEFAULT '',          -- canonical scene grouping key (scene id or import chapter)
    scene_title          TEXT NOT NULL DEFAULT '',
    scene_id             UUID REFERENCES scenes(id) ON DELETE SET NULL,
    chat_window_id       UUID REFERENCES chat_windows(id) ON DELETE SET NULL,
    visibility_scope     TEXT NOT NULL DEFAULT 'public' CHECK (visibility_scope IN ('public','gm','character')),
    audience             UUID[] NOT NULL DEFAULT '{}',
    source_kind          TEXT NOT NULL CHECK (source_kind IN ('channel_event','import')),
    source_event_id      UUID REFERENCES events(id) ON DELETE SET NULL,
    source_message_id    UUID REFERENCES messages(id) ON DELETE SET NULL,
    import_id            UUID,
    source_reference     JSONB NOT NULL DEFAULT '{}'::jsonb, -- {adapter, line_no, raw_index, im_user_id, ...}
    dice                 JSONB,                              -- {expression, rolls, total, check_name, outcome, raw}
    media                JSONB,                              -- [{kind, url_or_key, cq}]
    metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
    raw_text             TEXT,                               -- original line(s) for imports
    unrecognised         BOOLEAN NOT NULL DEFAULT false,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, sequence_number)
);
CREATE INDEX log_events_project_idx ON log_events(project_id, sequence_number);
CREATE INDEX log_events_scene_idx ON log_events(project_id, scene_key);

-- Versioned, immutable selections of events.
CREATE TABLE log_snapshots (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id     UUID NOT NULL REFERENCES log_projects(id) ON DELETE CASCADE,
    channel_id     UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    version        INTEGER NOT NULL,
    title          TEXT NOT NULL DEFAULT '',
    selection      JSONB NOT NULL DEFAULT '{}'::jsonb,    -- {mode: campaign|session|scenes|range, scene_ids, from_seq, to_seq, session}
    scope          TEXT NOT NULL DEFAULT 'gm_full' CHECK (scope IN ('gm_full','pl_public','character')),
    scope_character_id UUID REFERENCES characters(id) ON DELETE SET NULL,
    schema_version TEXT NOT NULL DEFAULT '1.0',
    event_count    INTEGER NOT NULL DEFAULT 0,
    created_by     UUID REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, version)
);
CREATE TABLE log_snapshot_events (
    snapshot_id  UUID NOT NULL REFERENCES log_snapshots(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,
    log_event_id UUID NOT NULL REFERENCES log_events(id) ON DELETE CASCADE,
    PRIMARY KEY (snapshot_id, position)
);
CREATE INDEX log_snapshot_events_event_idx ON log_snapshot_events(log_event_id);

CREATE TABLE log_imports (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL REFERENCES log_projects(id) ON DELETE CASCADE,
    channel_id   UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    adapter      TEXT NOT NULL,
    file_name    TEXT NOT NULL DEFAULT '',
    encoding     TEXT NOT NULL DEFAULT 'utf-8',
    status       TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed','committed','failed')),
    stats        JSONB NOT NULL DEFAULT '{}'::jsonb,
    speaker_map  JSONB NOT NULL DEFAULT '{}'::jsonb,
    raw_object_key TEXT,
    created_by   UUID REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    committed_at TIMESTAMPTZ
);
CREATE TABLE log_import_errors (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    import_id  UUID NOT NULL REFERENCES log_imports(id) ON DELETE CASCADE,
    line_no    INTEGER,
    raw        TEXT NOT NULL,
    reason     TEXT NOT NULL,
    severity   TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('warning','error'))
);
CREATE INDEX log_import_errors_import_idx ON log_import_errors(import_id);
ALTER TABLE log_events ADD CONSTRAINT log_events_import_fk FOREIGN KEY (import_id) REFERENCES log_imports(id) ON DELETE SET NULL;

-- Media assets (object storage references only).
CREATE TABLE media_assets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id          UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    asset_type          TEXT NOT NULL CHECK (asset_type IN ('background','standee','portrait','illustration','cover','audio','bgm','sfx','video','document','other')),
    source_type         TEXT NOT NULL CHECK (source_type IN ('upload','generated','mock','derived','import')),
    name                TEXT NOT NULL DEFAULT '',
    object_key          TEXT NOT NULL,
    mime                TEXT NOT NULL,
    bytes               BIGINT NOT NULL DEFAULT 0,
    width               INTEGER, height INTEGER, duration_ms INTEGER,
    character_id        UUID REFERENCES characters(id) ON DELETE SET NULL,
    expression          TEXT NOT NULL DEFAULT '',
    outfit              TEXT NOT NULL DEFAULT '',
    source_reference    JSONB NOT NULL DEFAULT '{}'::jsonb,
    generation_provider TEXT, generation_model TEXT, prompt TEXT,
    reference_asset_ids UUID[] NOT NULL DEFAULT '{}',
    style_profile_id    UUID, style_profile_version INTEGER,
    approval_status     TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('candidate','approved','rejected')),
    visibility_scope    TEXT NOT NULL DEFAULT 'channel' CHECK (visibility_scope IN ('channel','gm')),
    version             INTEGER NOT NULL DEFAULT 1,
    license_metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    tags                TEXT[] NOT NULL DEFAULT '{}',
    created_by          UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX media_assets_channel_idx ON media_assets(channel_id, asset_type);
CREATE TABLE asset_versions (
    asset_id   UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
    version    INTEGER NOT NULL,
    object_key TEXT NOT NULL,
    mime       TEXT NOT NULL,
    bytes      BIGINT NOT NULL DEFAULT 0,
    note       TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_id, version)
);

CREATE TABLE visual_style_profiles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id          UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    style_name          TEXT NOT NULL,
    art_direction       TEXT NOT NULL DEFAULT '',
    color_palette       JSONB NOT NULL DEFAULT '[]'::jsonb,
    lighting_style      TEXT NOT NULL DEFAULT '',
    rendering_style     TEXT NOT NULL DEFAULT '',
    period_setting      TEXT NOT NULL DEFAULT '',
    reference_asset_ids UUID[] NOT NULL DEFAULT '{}',
    negative_constraints TEXT NOT NULL DEFAULT '',
    aspect_ratio        TEXT NOT NULL DEFAULT '16:9',
    is_default          BOOLEAN NOT NULL DEFAULT false,
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE media_assets ADD CONSTRAINT media_assets_style_fk FOREIGN KEY (style_profile_id) REFERENCES visual_style_profiles(id) ON DELETE SET NULL;

CREATE TABLE character_visual_profiles (
    character_id        UUID PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
    channel_id          UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    description         TEXT NOT NULL DEFAULT '',          -- hair, face, attire, identity traits
    default_asset_id    UUID REFERENCES media_assets(id) ON DELETE SET NULL,
    expressions         JSONB NOT NULL DEFAULT '{}'::jsonb, -- expression -> asset_id
    reference_asset_ids UUID[] NOT NULL DEFAULT '{}',
    color               TEXT NOT NULL DEFAULT '',
    version             INTEGER NOT NULL DEFAULT 1,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Presentation layer.
CREATE TABLE log_presentations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL REFERENCES log_projects(id) ON DELETE CASCADE,
    snapshot_id  UUID NOT NULL REFERENCES log_snapshots(id) ON DELETE CASCADE,
    channel_id   UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    settings     JSONB NOT NULL DEFAULT '{}'::jsonb,       -- theme, animations_enabled, typewriter_speed, font, aspect
    style_profile_id UUID REFERENCES visual_style_profiles(id) ON DELETE SET NULL,
    version      INTEGER NOT NULL DEFAULT 1,
    created_by   UUID REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX log_presentations_project_idx ON log_presentations(project_id);
CREATE TABLE presentation_scenes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    presentation_id     UUID NOT NULL REFERENCES log_presentations(id) ON DELETE CASCADE,
    position            INTEGER NOT NULL,
    title               TEXT NOT NULL DEFAULT '',
    canonical_scene_key TEXT NOT NULL DEFAULT '',
    background_asset_id UUID REFERENCES media_assets(id) ON DELETE SET NULL,
    background_asset_version INTEGER,
    bgm_asset_id        UUID REFERENCES media_assets(id) ON DELETE SET NULL,
    environment         JSONB NOT NULL DEFAULT '{}'::jsonb, -- weather/lighting effects
    transition_in       TEXT NOT NULL DEFAULT 'fade',
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    locked              BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX presentation_scenes_pres_idx ON presentation_scenes(presentation_id, position);
CREATE TABLE presentation_events (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    presentation_id       UUID NOT NULL REFERENCES log_presentations(id) ON DELETE CASCADE,
    scene_id              UUID REFERENCES presentation_scenes(id) ON DELETE SET NULL,
    position              INTEGER NOT NULL,
    canonical_event_id    UUID REFERENCES log_events(id) ON DELETE CASCADE,
    merged_event_ids      UUID[] NOT NULL DEFAULT '{}',    -- consecutive lines displayed together
    segment_index         INTEGER NOT NULL DEFAULT 0,      -- long narration split into segments
    segment_text          TEXT,                             -- display text of this segment (verbatim substring); NULL = whole event
    display_kind          TEXT NOT NULL DEFAULT 'dialogue' CHECK (display_kind IN ('dialogue','narration','action','ooc','dice','scene_change','system','media')),
    hidden                BOOLEAN NOT NULL DEFAULT false,
    speaker_character_id  UUID REFERENCES characters(id) ON DELETE SET NULL,
    speaker_name_override TEXT,
    tts_text              TEXT,                             -- separately stored speech adaptation; NULL = use display text
    character_asset_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{character_id, asset_id, asset_version, position: left|center|right|x%, expression, scale, flip}]
    expression_ids        JSONB NOT NULL DEFAULT '{}'::jsonb,
    dialogue_style        JSONB NOT NULL DEFAULT '{}'::jsonb,
    voice_profile_id      UUID,
    audio_asset_id        UUID,                             -- tts_audio_assets.id
    style_instruction     TEXT NOT NULL DEFAULT '',          -- per-line delivery instruction
    transition            TEXT NOT NULL DEFAULT 'none',
    effect                TEXT NOT NULL DEFAULT 'none',
    estimated_duration_ms INTEGER NOT NULL DEFAULT 0,
    actual_audio_duration_ms INTEGER,
    ai_suggestion         JSONB,                             -- pending suggestion, applied only when accepted
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX presentation_events_pres_idx ON presentation_events(presentation_id, position);

-- Voice.
CREATE TABLE pronunciation_dictionaries (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    entries    JSONB NOT NULL DEFAULT '[]'::jsonb,       -- [{term, reading, mode: phoneme|replace, language}]
    version    INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE voice_profiles (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id         UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    character_id       UUID REFERENCES characters(id) ON DELETE SET NULL,
    name               TEXT NOT NULL DEFAULT '',
    provider           TEXT NOT NULL,                        -- qwen | mock
    model_id           TEXT NOT NULL,
    voice_id           TEXT NOT NULL,
    voice_type         TEXT NOT NULL CHECK (voice_type IN ('preset','design','clone')),
    language           TEXT NOT NULL DEFAULT 'zh',
    dialect            TEXT NOT NULL DEFAULT '',
    style_instruction  TEXT NOT NULL DEFAULT '',             -- voice identity-level instruction
    pronunciation_dictionary_id UUID REFERENCES pronunciation_dictionaries(id) ON DELETE SET NULL,
    synthesis_parameters JSONB NOT NULL DEFAULT '{}'::jsonb, -- speed, pitch, format
    consent_metadata   JSONB,                                -- required for clone: {consent_given, rights_holder, statement, recorded_at}
    design_prompt      TEXT,
    version            INTEGER NOT NULL DEFAULT 1,
    created_by         UUID REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX voice_profiles_channel_idx ON voice_profiles(channel_id);
ALTER TABLE presentation_events ADD CONSTRAINT presentation_events_voice_fk FOREIGN KEY (voice_profile_id) REFERENCES voice_profiles(id) ON DELETE SET NULL;

CREATE TABLE tts_audio_assets (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id     UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    cache_key      TEXT NOT NULL UNIQUE,                     -- sha256 over the synthesis inputs
    provider       TEXT NOT NULL, model_id TEXT NOT NULL, voice_id TEXT NOT NULL,
    voice_profile_id UUID REFERENCES voice_profiles(id) ON DELETE SET NULL,
    voice_profile_version INTEGER,
    spoken_text    TEXT NOT NULL,
    style_instruction TEXT NOT NULL DEFAULT '',
    dictionary_version INTEGER,
    synthesis_parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
    object_key     TEXT NOT NULL,
    mime           TEXT NOT NULL,
    bytes          BIGINT NOT NULL DEFAULT 0,
    duration_ms    INTEGER,
    word_timestamps JSONB,                                   -- only when the provider returned them
    is_mock        BOOLEAN NOT NULL DEFAULT false,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE presentation_events ADD CONSTRAINT presentation_events_audio_fk FOREIGN KEY (audio_asset_id) REFERENCES tts_audio_assets(id) ON DELETE SET NULL;

CREATE TABLE tts_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    presentation_id UUID REFERENCES log_presentations(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL DEFAULT 'batch' CHECK (kind IN ('batch','preview','voice_design','voice_clone')),
    scope           JSONB NOT NULL DEFAULT '{}'::jsonb,      -- {event_ids|scene_ids|all, force}
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','cancelled')),
    total           INTEGER NOT NULL DEFAULT 0,
    done            INTEGER NOT NULL DEFAULT 0,
    failed          INTEGER NOT NULL DEFAULT 0,
    cached          INTEGER NOT NULL DEFAULT 0,
    estimated_chars INTEGER NOT NULL DEFAULT 0,
    estimated_cost  NUMERIC(12,6) NOT NULL DEFAULT 0,
    provider        TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 3,
    idempotency_key TEXT UNIQUE,
    error           TEXT,
    result          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ, finished_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tts_jobs_status_idx ON tts_jobs(status, created_at);
CREATE TABLE tts_usage_records (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    job_id        UUID REFERENCES tts_jobs(id) ON DELETE SET NULL,
    provider      TEXT NOT NULL, model_id TEXT NOT NULL,
    chars         INTEGER NOT NULL,
    estimated_cost NUMERIC(12,6) NOT NULL DEFAULT 0,
    cached        BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tts_usage_channel_idx ON tts_usage_records(channel_id, created_at);
ALTER TABLE channels ADD COLUMN IF NOT EXISTS tts_budget_chars BIGINT NOT NULL DEFAULT 2000000;

-- Image generation jobs (provider abstraction; disabled unless configured).
CREATE TABLE asset_generation_jobs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('background','standee')),
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','cancelled')),
    provider    TEXT NOT NULL,
    prompt      TEXT NOT NULL,
    params      JSONB NOT NULL DEFAULT '{}'::jsonb,
    style_profile_id UUID REFERENCES visual_style_profiles(id) ON DELETE SET NULL,
    character_id UUID REFERENCES characters(id) ON DELETE SET NULL,
    result_asset_id UUID REFERENCES media_assets(id) ON DELETE SET NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);

-- Publication configuration.
CREATE TABLE pdf_templates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  UUID REFERENCES channels(id) ON DELETE CASCADE,  -- NULL = built-in
    name        TEXT NOT NULL,
    base        TEXT NOT NULL CHECK (base IN ('classic','dossier','novel')),
    config      JSONB NOT NULL DEFAULT '{}'::jsonb,
    version     INTEGER NOT NULL DEFAULT 1,
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE pdf_render_jobs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    project_id    UUID NOT NULL REFERENCES log_projects(id) ON DELETE CASCADE,
    snapshot_id   UUID NOT NULL REFERENCES log_snapshots(id) ON DELETE CASCADE,
    template_id   UUID REFERENCES pdf_templates(id) ON DELETE SET NULL,
    template_config JSONB NOT NULL DEFAULT '{}'::jsonb,     -- frozen copy
    scope         TEXT NOT NULL DEFAULT 'pl_public' CHECK (scope IN ('gm_full','pl_public','character')),
    scope_character_id UUID REFERENCES characters(id) ON DELETE SET NULL,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','cancelled')),
    worker_id     TEXT,
    object_key    TEXT,
    bytes         BIGINT, pages INTEGER,
    attempts      INTEGER NOT NULL DEFAULT 0,
    max_attempts  INTEGER NOT NULL DEFAULT 2,
    idempotency_key TEXT UNIQUE,
    error         TEXT,
    created_by    UUID REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at    TIMESTAMPTZ, finished_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pdf_render_jobs_status_idx ON pdf_render_jobs(status, created_at);

CREATE TABLE published_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES log_projects(id) ON DELETE CASCADE,
    snapshot_id     UUID NOT NULL REFERENCES log_snapshots(id) ON DELETE CASCADE,
    presentation_id UUID REFERENCES log_presentations(id) ON DELETE SET NULL,
    pdf_job_id      UUID REFERENCES pdf_render_jobs(id) ON DELETE SET NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('styled','vn','pdf')),
    title           TEXT NOT NULL,
    visibility      TEXT NOT NULL DEFAULT 'players' CHECK (visibility IN ('gm','players','link')),
    share_token     TEXT UNIQUE,
    frozen_asset_versions JSONB NOT NULL DEFAULT '{}'::jsonb,  -- asset_id -> version at publication
    revoked         BOOLEAN NOT NULL DEFAULT false,
    published_by    UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ
);
CREATE INDEX published_logs_channel_idx ON published_logs(channel_id);

-- Export / access audit.
CREATE TABLE studio_audit_log (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    action     TEXT NOT NULL,
    target     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX studio_audit_channel_idx ON studio_audit_log(channel_id, created_at DESC);
