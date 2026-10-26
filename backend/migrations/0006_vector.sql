-- 0006_vector: optional semantic retrieval. pgvector is used when available; otherwise FTS only.
DO $$
BEGIN
    BEGIN
        CREATE EXTENSION IF NOT EXISTS vector;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'pgvector not available, semantic retrieval disabled';
    END;
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        EXECUTE 'CREATE TABLE IF NOT EXISTS fact_embeddings (
            fact_id UUID PRIMARY KEY REFERENCES knowledge_facts(id) ON DELETE CASCADE,
            model TEXT NOT NULL,
            embedding vector(1536) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now())';
    END IF;
END $$;
