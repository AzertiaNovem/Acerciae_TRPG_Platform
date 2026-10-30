-- Per-channel AI switches for the GM, under the server's feature switches: a channel with everything off is a plain
-- chat room that costs no tokens (ai_enabled already covers the observer/consolidator behind the bubbles).
ALTER TABLE channels
    ADD COLUMN consistency_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN inspiration_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN atmosphere_enabled  BOOLEAN NOT NULL DEFAULT TRUE;
