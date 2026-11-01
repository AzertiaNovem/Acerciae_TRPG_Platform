-- Prompt caching: how much of each call's prompt the provider served from its cache (read) or stored in it (write).
-- prompt_tokens keeps counting the whole prompt, so token budgets mean what they meant before caching.
ALTER TABLE ai_usage_records
    ADD COLUMN cache_read_tokens  INT NOT NULL DEFAULT 0,
    ADD COLUMN cache_write_tokens INT NOT NULL DEFAULT 0;
