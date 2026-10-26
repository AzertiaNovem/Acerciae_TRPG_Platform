-- 0005_modules: PDF module import as a conditional knowledge graph (separate layer from play events)
CREATE TABLE modules (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id   UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    file_name    TEXT NOT NULL DEFAULT '',
    file_path    TEXT NOT NULL DEFAULT '',
    page_count   INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','extracting','structuring','ready','failed')),
    error        TEXT,
    llm_mode     TEXT NOT NULL DEFAULT 'mock',
    uploaded_by  UUID REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX modules_channel_idx ON modules(channel_id);

CREATE TABLE module_pages (
    module_id   UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    text        TEXT NOT NULL,
    search      TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
    PRIMARY KEY (module_id, page_number)
);
CREATE INDEX module_pages_search_idx ON module_pages USING GIN(search);

CREATE TABLE module_nodes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id   UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    node_type   TEXT NOT NULL CHECK (node_type IN ('npc','location','item','clue','secret','stage','scene','condition','twist','ending')),
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    data        JSONB NOT NULL DEFAULT '{}'::jsonb,
    citations   JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{page, excerpt}]
    gm_edited   BOOLEAN NOT NULL DEFAULT false,
    progress    TEXT NOT NULL DEFAULT 'untouched' CHECK (progress IN ('untouched','active','revealed','completed','skipped')),
    progress_event_ids UUID[] NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    search      TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', name || ' ' || description)) STORED
);
CREATE INDEX module_nodes_module_idx ON module_nodes(module_id, node_type);
CREATE INDEX module_nodes_search_idx ON module_nodes USING GIN(search);
CREATE INDEX module_nodes_name_trgm_idx ON module_nodes USING GIN (name gin_trgm_ops);

CREATE TABLE module_edges (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id   UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    from_node_id UUID NOT NULL REFERENCES module_nodes(id) ON DELETE CASCADE,
    to_node_id   UUID NOT NULL REFERENCES module_nodes(id) ON DELETE CASCADE,
    relation    TEXT NOT NULL,     -- requires, reveals, leads_to, located_in, knows, holds, unlocks, triggers
    data        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX module_edges_from_idx ON module_edges(from_node_id);
CREATE INDEX module_edges_to_idx ON module_edges(to_node_id);

-- GM-facing "potential association" hints raised when play deviates from the module.
CREATE TABLE module_hints (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    module_id     UUID REFERENCES modules(id) ON DELETE CASCADE,
    node_id       UUID REFERENCES module_nodes(id) ON DELETE CASCADE,
    fact_id       UUID REFERENCES knowledge_facts(id) ON DELETE CASCADE,
    reason        TEXT NOT NULL,
    source_event_ids UUID[] NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'potential' CHECK (status IN ('potential','accepted','dismissed')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX module_hints_channel_idx ON module_hints(channel_id, status);

ALTER TABLE scenes ADD CONSTRAINT scenes_module_node_fk FOREIGN KEY (module_node_id) REFERENCES module_nodes(id) ON DELETE SET NULL;
ALTER TABLE entities ADD CONSTRAINT entities_module_node_fk FOREIGN KEY (module_node_id) REFERENCES module_nodes(id) ON DELETE SET NULL;
