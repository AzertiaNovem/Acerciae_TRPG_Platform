-- 0003_knowledge_documents: fact-knower model, documents, revisions, highlights
-- Facts are the canonical structured memory ("shards"). Documents project facts into readable views.

CREATE TABLE entities (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('pc','npc','location','item','organisation','concept')),
    name        TEXT NOT NULL,
    aliases     TEXT[] NOT NULL DEFAULT '{}',
    description TEXT NOT NULL DEFAULT '',
    character_id UUID REFERENCES characters(id) ON DELETE SET NULL,
    module_node_id UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (channel_id, kind, name)
);
CREATE INDEX entities_name_trgm_idx ON entities USING GIN (name gin_trgm_ops);

-- status captures the epistemic state the spec requires us to distinguish.
CREATE TABLE knowledge_facts (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id       UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL CHECK (kind IN ('scene_state','clue','relationship','thread','timeline','entity','module_progress','note')),
    summary          TEXT NOT NULL,
    data             JSONB NOT NULL DEFAULT '{}'::jsonb,
    status           TEXT NOT NULL DEFAULT 'confirmed'
                     CHECK (status IN ('attempted','confirmed','npc_claim','hypothesis','ai_inferred','gm_secret','retracted','resolved','pending_review')),
    scene_id         UUID REFERENCES scenes(id) ON DELETE SET NULL,
    source_event_ids UUID[] NOT NULL DEFAULT '{}',
    created_by       TEXT NOT NULL DEFAULT 'ai' CHECK (created_by IN ('ai','gm','system')),
    version          INTEGER NOT NULL DEFAULT 1,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    search           TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', summary || ' ' || coalesce(data::text,''))) STORED
);
CREATE INDEX knowledge_facts_channel_kind_idx ON knowledge_facts(channel_id, kind);
CREATE INDEX knowledge_facts_search_idx ON knowledge_facts USING GIN(search);
CREATE INDEX knowledge_facts_summary_trgm_idx ON knowledge_facts USING GIN (summary gin_trgm_ops);

-- Fact–Knower mapping. scope 'gm' = GM only; 'public' = every player; 'character' = that character only.
CREATE TABLE knowledge_visibility (
    fact_id      UUID NOT NULL REFERENCES knowledge_facts(id) ON DELETE CASCADE,
    scope        TEXT NOT NULL CHECK (scope IN ('gm','public','character')),
    character_id UUID REFERENCES characters(id) ON DELETE CASCADE,
    source       TEXT NOT NULL DEFAULT 'event' CHECK (source IN ('event','gm','ai_proposal')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (fact_id, scope, character_id)
);
CREATE INDEX knowledge_visibility_character_idx ON knowledge_visibility(character_id);

CREATE TABLE fact_entities (
    fact_id   UUID NOT NULL REFERENCES knowledge_facts(id) ON DELETE CASCADE,
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT 'mentioned',
    PRIMARY KEY (fact_id, entity_id, role)
);
CREATE INDEX fact_entities_entity_idx ON fact_entities(entity_id);

CREATE TABLE entity_relations (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id     UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    from_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    to_entity_id   UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relation       TEXT NOT NULL,          -- promised, owes, distrusts, allied, knows, located_at, possesses, ...
    fact_id        UUID REFERENCES knowledge_facts(id) ON DELETE CASCADE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX entity_relations_from_idx ON entity_relations(from_entity_id);
CREATE INDEX entity_relations_to_idx ON entity_relations(to_entity_id);

CREATE TABLE clues (
    fact_id          UUID PRIMARY KEY REFERENCES knowledge_facts(id) ON DELETE CASCADE,
    channel_id       UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title            TEXT NOT NULL,
    discovered_by    UUID[] NOT NULL DEFAULT '{}',
    discovered_scene UUID REFERENCES scenes(id) ON DELETE SET NULL,
    confirmed        BOOLEAN NOT NULL DEFAULT false,
    related_fact_ids UUID[] NOT NULL DEFAULT '{}'
);

CREATE TABLE narrative_threads (
    fact_id     UUID PRIMARY KEY REFERENCES knowledge_facts(id) ON DELETE CASCADE,
    channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    thread_kind TEXT NOT NULL DEFAULT 'question' CHECK (thread_kind IN ('question','foreshadowing','promise','agreement','deadline')),
    resolved    BOOLEAN NOT NULL DEFAULT false,
    resolved_event_id UUID REFERENCES events(id) ON DELETE SET NULL
);

-- Documents: stable IDs, independent versions. doc_type is one of the core narrative documents.
CREATE TABLE documents (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    doc_type    TEXT NOT NULL CHECK (doc_type IN ('current_scene','clue_journal','relationships','open_threads','timeline','module_progress')),
    title       TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 0,
    gm_only     BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (channel_id, doc_type)
);

-- An entry is a stable, addressable unit of a document, backed by a fact.
CREATE TABLE document_entries (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    fact_id      UUID NOT NULL REFERENCES knowledge_facts(id) ON DELETE CASCADE,
    section      TEXT NOT NULL DEFAULT '',
    position     INTEGER NOT NULL DEFAULT 0,
    content_md   TEXT NOT NULL,
    removed      BOOLEAN NOT NULL DEFAULT false,
    created_version INTEGER NOT NULL,
    updated_version INTEGER NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, fact_id)
);
CREATE INDEX document_entries_doc_idx ON document_entries(document_id, position);

-- Each committed proposal produces one revision with the ops applied and a snapshot for rollback.
CREATE TABLE document_revisions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    actor        TEXT NOT NULL CHECK (actor IN ('ai','gm','system')),
    actor_user_id UUID REFERENCES users(id),
    ops          JSONB NOT NULL,
    snapshot     JSONB NOT NULL,            -- entries after applying ops
    summary      TEXT NOT NULL DEFAULT '',
    source_event_ids UUID[] NOT NULL DEFAULT '{}',
    ai_job_id    UUID,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, version)
);

-- Short-term attention mechanism, separate from long-term document memory.
CREATE TABLE highlights (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id       UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    document_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    target_entry_id  UUID REFERENCES document_entries(id) ON DELETE CASCADE,
    text_range       JSONB,                -- {"start":int,"end":int} within entry content, optional
    reason           TEXT NOT NULL,
    kind             TEXT NOT NULL DEFAULT 'association' CHECK (kind IN ('association','consistency','potential_association','correction')),
    source_event_ids UUID[] NOT NULL DEFAULT '{}',
    priority         INTEGER NOT NULL DEFAULT 1,
    visibility_scope TEXT NOT NULL DEFAULT 'public' CHECK (visibility_scope IN ('gm','public','character','user')),
    character_id     UUID REFERENCES characters(id) ON DELETE CASCADE,
    user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
    dismissed        BOOLEAN NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at       TIMESTAMPTZ NOT NULL
);
CREATE INDEX highlights_channel_active_idx ON highlights(channel_id, expires_at) WHERE NOT dismissed;
CREATE INDEX highlights_entry_idx ON highlights(target_entry_id);
